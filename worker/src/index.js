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

// Replace OSC-HOSTNAME with the URL OSC gives you after deployment.
const ALLOWED_ORIGINS = new Set([
  'https://OSC-HOSTNAME',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
]);
// Sent upstream to Mapbox so URL-restricted tokens still accept the call.
// Must match a hostname on the token's allowlist in the Mapbox dashboard.
const REFERER = 'https://OSC-HOSTNAME/';

// Static-image endpoint. Mapbox Static Images free tier is 50k/month.
const STATIC_BASE       = 'https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static';
const MAX_MONTHLY       = 40000;
const PER_IP_PER_MIN    = 10;
// Captures are rare (one per CAPTURE button click) so a small sample rate
// keeps the counter close to the truth without burning many writes.
const STATIC_SAMPLE_N   = 5;

// Tile endpoint. Mapbox Raster Tiles free tier is 200k/month — but the
// edge cache means we only hit Mapbox on tile cache misses, so even much
// busier traffic stays within budget.
const TILE_BASE             = 'https://api.mapbox.com/v4/mapbox.satellite';
// Lower than Mapbox's 200k free tier to leave headroom for sampled-counter
// noise: with N=50 the counter's stddev is ~50·sqrt(actual·(1−1/N)/N), so
// a 160k cap reads as roughly 160k ± 2k. Stays comfortably under 200k.
const MAX_MONTHLY_TILES     = 160000;
const PER_IP_PER_MIN_TILES  = 100;
const TILE_SAMPLE_N         = 50;

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
