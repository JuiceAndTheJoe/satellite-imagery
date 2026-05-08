# satellite-imagery

3D globe + Mapbox-backed satellite snapshot viewer. Spin the globe, pick a
target, pull a static image of that patch of Earth.

```
satellite-imagery/
├─ index.html        Globe + capture UI
├─ space.css         Styling
├─ space.js          App logic + globe.gl wiring
├─ tiles/            Pre-built tier-1 city tiles + manifest
│  ├─ build-cache.mjs   Offline tile pre-fetcher
│  └─ manifest.json
└─ worker/           Cloudflare Worker that proxies Mapbox
   ├─ src/index.js
   ├─ wrangler.toml
   └─ README.md
```

## How it fits together

The browser never sees the Mapbox token. All tile and static-image requests
go to the Cloudflare Worker, which holds the token as a secret, enforces
per-IP burst limits and a global monthly cap, and stamps long-cache headers
so Cloudflare's edge cache absorbs most of the load.

The most-clicked cities are pre-fetched into `tiles/` so a city click +
close-zoom never touches Mapbox at all.

## Deploy

### 1. Cloudflare Worker (proxy)

```bash
cd worker
wrangler login
wrangler kv namespace create QUOTA          # paste id into wrangler.toml
wrangler secret put MAPBOX_TOKEN            # paste your Mapbox public token
wrangler deploy
```

`wrangler deploy` prints the Worker URL. Paste it into:

- `PROXY_BASE` in `space.js`
- `WORKER_BASE` in `tiles/build-cache.mjs` (only if you want to rebuild
  bundled tiles)

### 2. Static frontend (OSC)

Push this repo to GitHub, then deploy via OSC's Eyevinn Web Server pointing
at the repo. After OSC gives you the live URL:

1. Edit `ALLOWED_ORIGINS` and `REFERER` in `worker/src/index.js` to use
   the OSC hostname.
2. `cd worker && wrangler deploy`
3. In the Mapbox dashboard, scope the token's URL allowlist to the OSC
   hostname (and the worker subdomain).

### 3. (Optional) Rebuild the bundled tiles

```bash
node tiles/build-cache.mjs
```

Re-running is safe; already-on-disk tiles are skipped.

## Local dev

Any static file server at the repo root works, e.g.:

```bash
npx http-server . -p 8080
```

Open `http://localhost:8080`. The Worker's `ALLOWED_ORIGINS` already
includes `http://localhost:8080`.

## Credits

Imagery © Mapbox © OpenStreetMap. Globe rendering via [globe.gl](https://globe.gl).
City labels and country borders from
[Natural Earth](https://www.naturalearthdata.com/).
