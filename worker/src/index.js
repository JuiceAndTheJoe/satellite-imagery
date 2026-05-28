// Cloudflare Worker that proxies Mapbox calls for the satellite-imagery app.
// The Mapbox token lives only here as a Worker secret — it never reaches
// the browser.
//
// Two endpoints, with independent quotas:
//
//   GET /?lat=…&lon=…&zoom=…    — Static-image endpoint, hit by CAPTURE.
//                                  One Mapbox request per call.
//   GET /tile/{z}/{x}/{y}        — Tile endpoint, hit by the close-zoom
//                                  globe overlay. Many requests per
//                                  session, but Cloudflare's edge cache
//                                  absorbs most of the load (immutable
//                                  tiles → near-100% hit rate after
//                                  warm-up over major cities).
//
// Hard caps per month + per-IP-per-minute on each endpoint, so a runaway
// client or a viral moment can't blow past Mapbox's free tier.
//
// Workers KV free tier is 1k writes/day, so this Worker is careful never
// to write to KV on the hot path:
//   - Per-IP rate-limit counters live in the Cache API (free, per-DC,
//     functionally per-user since a single client routes to one DC).
//   - Monthly Mapbox-call counters use sampled writes — record 1-in-N
//     calls with increment=N, so the running total tracks the truth on
//     average while writes drop ~Nx.

const ALLOWED_ORIGINS = new Set([
  'https://satellite.apps.osaas.io',
  'https://team2-satelliteimagery.eyevinn-web-runner.auto.prod.osaas.io',
  'https://3288ab1a9f.apps.osaas.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
]);
// Sent upstream to Mapbox so URL-restricted tokens still accept the call.
// Must match a hostname on the token's allowlist in the Mapbox dashboard.
const REFERER = 'https://team2-satelliteimagery.eyevinn-web-runner.auto.prod.osaas.io/';

// Static-image endpoint. Mapbox Static Images free tier is 50k/month.
const STATIC_BASE       = 'https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static';
// Pulled below the 50k free tier with a wide margin so sampled-counter
// race conditions and KV eventual-consistency windows can't push real
// usage past the free limit under concurrent attack.
const MAX_MONTHLY       = 30000;
// CAPTURE is an explicit user click — a real user almost never clicks it
// faster than a couple times a minute. 3/min/IP shuts down scripted abuse
// while staying well above legit interaction.
const PER_IP_PER_MIN    = 3;
// Captures are rare (one per CAPTURE button click) so a small sample rate
// keeps the counter close to the truth without burning many writes.
const STATIC_SAMPLE_N   = 5;

// Tile endpoint. Mapbox Raster Tiles free tier is 200k/month — but the
// edge cache means we only hit Mapbox on tile cache misses, so even much
// busier traffic stays within budget.
const TILE_BASE             = 'https://api.mapbox.com/v4/mapbox.satellite';
// Headroom under Mapbox's 200k free tier to absorb sampled-counter noise
// (with N=50 the counter's stddev is ~50·sqrt(actual·(1−1/N)/N)) plus the
// race-condition slop that lets concurrent workers undercount.
const MAX_MONTHLY_TILES     = 140000;
// 60/min/IP is enough headroom for legit pan/zoom bursts on the globe
// (most tiles hit the edge cache anyway) but cuts scripted abuse to
// ~40% of the previous ceiling.
const PER_IP_PER_MIN_TILES  = 60;
const TILE_SAMPLE_N         = 50;

// Cloudflare Turnstile siteverify endpoint. The Worker validates a token
// minted by the frontend widget before letting an expensive request reach
// Mapbox. If env.TURNSTILE_SECRET is unset, the gate is skipped — so this
// stays a no-op until the user finishes Turnstile setup in the dashboard.
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const TILE_PATH_RE = /^\/tile\/(\d+)\/(\d+)\/(\d+)$/;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

// `<img src>` requests don't send an Origin header — only Referer. Accept
// either as proof that the call is coming from one of our pages.
function isAllowedCaller(req) {
  const origin = req.headers.get('Origin') || '';
  if (ALLOWED_ORIGINS.has(origin)) return true;
  const referer = req.headers.get('Referer') || '';
  for (const allowed of ALLOWED_ORIGINS) {
    if (referer === allowed || referer.startsWith(allowed + '/')) return true;
  }
  return false;
}

function monthSuffix(d = new Date()) {
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}`;
}
function staticMonthKey() { return `count:${monthSuffix()}`; }
function tileMonthKey()   { return `tilecount:${monthSuffix()}`; }

function jsonError(msg, status, headers) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// Per-IP rate limit using the Cache API. KV writes burn the 1k/day free
// tier fast; Cache puts are free and unlimited. The trade-off is that the
// CF cache is per-data-center, so this rate-limits per (IP × DC) instead
// of globally per IP — fine in practice, since a client almost always
// routes to one DC at a time.
//
// Returns true if the request is under cap and the counter has been
// bumped, false if the cap was hit.
async function bumpRateLimit(prefix, ip, max) {
  const minute = Math.floor(Date.now() / 60000);
  const url = `https://rl.local/${prefix}/${encodeURIComponent(ip)}/${minute}`;
  const cache = caches.default;
  const cached = await cache.match(url);
  let count = 0;
  if (cached) count = parseInt(await cached.text(), 10) || 0;
  if (count >= max) return false;
  await cache.put(
    url,
    new Response(String(count + 1), {
      headers: { 'Cache-Control': 'public, max-age=120' },
    })
  );
  return true;
}

// Sampled increment for the monthly Mapbox-call counters. Writing on every
// hot-path request burned through 1k KV writes/day in a few hours.
// Instead, with probability 1/N write `current + N` so the long-run mean
// equals the true count. The cap-check still reads the counter on every
// request (reads are 100k/day — plenty of headroom).
function sampledIncrement(env, ctx, key, current, sampleN) {
  if (Math.random() < 1 / sampleN) {
    ctx.waitUntil(env.QUOTA.put(key, String(current + sampleN)));
  }
}

// Verify a Cloudflare Turnstile token by POSTing to siteverify with the
// Worker's secret. Returns true on success, false on missing/invalid token,
// and (intentionally) true when the secret isn't configured — so deploying
// this code before the dashboard setup is finished doesn't 403 every
// CAPTURE click. Once env.TURNSTILE_SECRET is set, the gate activates.
async function verifyTurnstile(token, ip, secret) {
  if (!secret) return true;
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip !== 'unknown') body.set('remoteip', ip);
  try {
    const r = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) return false;
    const j = await r.json();
    return !!j.success;
  } catch {
    return false;
  }
}

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (req.method !== 'GET') {
      return jsonError('Method not allowed', 405, cors);
    }
    if (!isAllowedCaller(req)) {
      return jsonError('Forbidden origin', 403, cors);
    }

    const u = new URL(req.url);
    const tileMatch = u.pathname.match(TILE_PATH_RE);
    if (tileMatch) {
      return handleTile(req, env, ctx, cors, tileMatch);
    }
    return handleStatic(req, env, ctx, cors, u);
  },
};

async function handleStatic(req, env, ctx, cors, u) {
  const lat = parseFloat(u.searchParams.get('lat'));
  const lon = parseFloat(u.searchParams.get('lon'));
  const zoom = parseInt(u.searchParams.get('zoom'), 10);

  if (
    Number.isNaN(lat) || lat < -90 || lat > 90 ||
    Number.isNaN(lon) || lon < -180 || lon > 180 ||
    Number.isNaN(zoom) || zoom < 4 || zoom > 20
  ) {
    return jsonError('Invalid lat/lon/zoom', 400, cors);
  }

  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';

  // Captcha gate runs BEFORE the rate-limit / quota reads so failing
  // requests cost nothing on the KV-write path. No-op when
  // env.TURNSTILE_SECRET is unset; once set, every CAPTURE must arrive
  // with a valid `cf` query param (token from the Turnstile widget).
  const tsToken = u.searchParams.get('cf') || req.headers.get('cf-turnstile-token');
  if (!(await verifyTurnstile(tsToken, ip, env.TURNSTILE_SECRET))) {
    return jsonError('Captcha required', 403, cors);
  }

  if (!(await bumpRateLimit('s', ip, PER_IP_PER_MIN))) {
    return jsonError('Rate limited — slow down', 429, cors);
  }

  const mKey = staticMonthKey();
  const monthly = parseInt((await env.QUOTA.get(mKey)) || '0', 10);
  if (monthly >= MAX_MONTHLY) {
    return jsonError('Monthly cap reached — try again next month', 429, cors);
  }

  const mapboxUrl =
    `${STATIC_BASE}/${lon.toFixed(6)},${lat.toFixed(6)},${zoom},0/512x512@2x` +
    `?access_token=${env.MAPBOX_TOKEN}&logo=false&attribution=false`;

  // Spoof Referer so URL-restricted tokens accept the call. Keeping the
  // restriction on means a leaked token still can't be used from the open
  // internet without also spoofing this header.
  const upstream = await fetch(mapboxUrl, {
    headers: { 'Referer': REFERER },
  });

  if (!upstream.ok) {
    return jsonError(`Upstream ${upstream.status}`, 502, cors);
  }

  sampledIncrement(env, ctx, mKey, monthly, STATIC_SAMPLE_N);

  const out = new Headers(cors);
  out.set('Content-Type', upstream.headers.get('Content-Type') || 'image/jpeg');
  out.set('Cache-Control', 'public, max-age=86400');
  return new Response(upstream.body, { status: 200, headers: out });
}

async function handleTile(req, env, ctx, cors, [, zStr, xStr, yStr]) {
  const z = parseInt(zStr, 10);
  const x = parseInt(xStr, 10);
  const y = parseInt(yStr, 10);
  const max = z >= 0 && z <= 30 ? (1 << z) : 0;
  if (
    !Number.isInteger(z) || z < 0 || z > 22 ||
    !Number.isInteger(x) || x < 0 || x >= max ||
    !Number.isInteger(y) || y < 0 || y >= max
  ) {
    return jsonError('Invalid tile coords', 400, cors);
  }

  // Edge cache lookup runs FIRST so cache hits never touch KV — the
  // Workers KV free tier is only 1k puts/day, and a per-request rate-limit
  // write before the cache check burns through it on bot traffic.
  // Cache key intentionally has no query string and no origin info so
  // every visitor shares the same cached entry. CORS headers are NOT
  // cached — we add them to the response per request.
  const cacheKey = new Request(`https://tile-cache/${z}/${x}/${y}.jpg`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(cached.body, { status: cached.status, headers });
  }

  // Cache miss — apply per-IP burst cap before paying for the Mapbox call.
  // Cache hits don't reach here, so cached traffic costs zero KV writes.
  // Per-IP counter lives in the Cache API (free, per-DC) instead of KV.
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await bumpRateLimit('t', ip, PER_IP_PER_MIN_TILES))) {
    return jsonError('Tile rate limited — slow down', 429, cors);
  }

  // Monthly Mapbox cap.
  const mKey = tileMonthKey();
  const monthly = parseInt((await env.QUOTA.get(mKey)) || '0', 10);
  if (monthly >= MAX_MONTHLY_TILES) {
    return jsonError('Monthly tile cap reached — try again next month', 429, cors);
  }

  const upstream = await fetch(
    `${TILE_BASE}/${z}/${x}/${y}@2x.jpg?access_token=${env.MAPBOX_TOKEN}`,
    { headers: { 'Referer': REFERER } }
  );
  if (!upstream.ok) {
    return jsonError(`Upstream ${upstream.status}`, 502, cors);
  }

  // Buffer the body once so we can both cache it and return it. Tiles top
  // out around ~30 KB so the doubled-memory cost is trivial.
  const body = await upstream.arrayBuffer();
  const contentType = upstream.headers.get('Content-Type') || 'image/jpeg';

  // Edge cache entry — long-lived, no CORS, no Vary. Mapbox satellite
  // tiles for a given (z,x,y) are effectively immutable; the rare base
  // imagery refresh is small enough that a 1-year TTL is fine.
  const cacheHeaders = new Headers();
  cacheHeaders.set('Content-Type', contentType);
  cacheHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
  ctx.waitUntil(
    cache.put(cacheKey, new Response(body, { status: 200, headers: cacheHeaders }))
  );
  sampledIncrement(env, ctx, mKey, monthly, TILE_SAMPLE_N);

  // Per-request response with CORS headers on top of the cache headers.
  const out = new Headers(cors);
  out.set('Content-Type', contentType);
  out.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(body, { status: 200, headers: out });
}
