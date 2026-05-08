# satellite-imagery-proxy (Cloudflare Worker)

Server-side proxy for the satellite-imagery app. Holds the Mapbox token as a
Worker secret and enforces a global monthly request cap so the free tier
can't be blown through.

## What it enforces

- `MAX_MONTHLY = 30000` — global counter in KV for the static-image
  endpoint. When hit, returns 429 without calling Mapbox. Resets on the
  1st of each month (UTC). Set well below Mapbox's 50k free tier to
  absorb sampled-counter overshoot.
- `MAX_MONTHLY_TILES = 140000` — same idea for raster tiles (free tier
  200k). Tile cache hits don't count.
- `PER_IP_PER_MIN = 3` — static-image burst limit (CAPTURE clicks).
- `PER_IP_PER_MIN_TILES = 60` — tile burst limit per visitor IP. Note:
  per-Cloudflare-data-center, not global, so determined attackers using
  proxies across regions can bypass it. The monthly cap is the real
  backstop.
- `ALLOWED_ORIGINS` — only requests from the deployed app origin (and
  localhost) are accepted; everything else gets 403. Cheap to spoof —
  treat as a hotlink filter, not real auth.
- **Turnstile gate** (optional, see below) — Cloudflare's invisible bot
  challenge in front of the static-image endpoint. The strongest single
  defense against scripted CAPTURE abuse.

The Worker also sets a `Referer` header on the upstream Mapbox call so the
URL-restricted token still works.

## Deploy

```bash
cd worker

# 1. Sign into Cloudflare (opens browser)
wrangler login

# 2. Create the KV namespace, then paste the printed id into wrangler.toml
wrangler kv namespace create QUOTA

# 3. Set the Mapbox token as a secret (paste at the prompt)
wrangler secret put MAPBOX_TOKEN

# 4. Deploy
wrangler deploy
```

`wrangler deploy` prints a URL like
`https://satellite-imagery-proxy.<acct>.workers.dev`. Paste that into
`PROXY_BASE` in `space.js` at the repo root.

After OSC gives you the live app URL, edit `ALLOWED_ORIGINS` and `REFERER`
in `src/index.js` to point at it, then re-run `wrangler deploy`.

## Enabling the Turnstile gate (recommended)

The Worker validates a Turnstile token before letting any CAPTURE reach
Mapbox. The frontend renders an invisible widget; the Worker calls
siteverify with `TURNSTILE_SECRET`. Until the secret is set the gate is a
no-op, so you can ship the code first and turn it on later.

1. Go to https://dash.cloudflare.com/?to=/:account/turnstile and create
   a new Turnstile site. Pick **Invisible** widget mode. Add the OSC
   hostname (and `localhost` for dev) as allowed domains.
2. Copy the **sitekey** into `TURNSTILE_SITEKEY` near the top of
   `space.js`.
3. Set the **secret key** as a Worker secret:
   ```bash
   cd worker
   wrangler secret put TURNSTILE_SECRET
   wrangler deploy
   ```
4. Redeploy the OSC app (push the `space.js` change to the repo).

After both are in place, every CAPTURE click sends `?cf=<token>`; the
Worker rejects requests without a valid token with `403 Captcha required`.

## Updating the cap

Edit `MAX_MONTHLY` in `src/index.js` and re-run `wrangler deploy`. To reset
the counter mid-month: `wrangler kv key delete --binding QUOTA "count:YYYY-MM"`.

## Monitoring

- `wrangler tail` — live logs.
- `wrangler kv key get --binding QUOTA "count:YYYY-MM"` — current month's count.
