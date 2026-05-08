# satellite-imagery-proxy (Cloudflare Worker)

Server-side proxy for the satellite-imagery app. Holds the Mapbox token as a
Worker secret and enforces a global monthly request cap so the free tier
can't be blown through.

## What it enforces

- `MAX_MONTHLY = 40000` — global counter in KV. When hit, returns 429 without
  calling Mapbox. Resets on the 1st of each month (UTC).
- `PER_IP_PER_MIN = 10` — burst limit per visitor IP.
- `ALLOWED_ORIGINS` — only requests from the deployed app origin (and
  localhost) are accepted; everything else gets 403.

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

## Updating the cap

Edit `MAX_MONTHLY` in `src/index.js` and re-run `wrangler deploy`. To reset
the counter mid-month: `wrangler kv key delete --binding QUOTA "count:YYYY-MM"`.

## Monitoring

- `wrangler tail` — live logs.
- `wrangler kv key get --binding QUOTA "count:YYYY-MM"` — current month's count.
