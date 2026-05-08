#!/usr/bin/env node
// One-time tile pre-fetcher. For each tier-1 city in space.js, downloads
// satellite tiles at the city-view zoom levels and writes them under
// tiles/{z}/{x}/{y}.jpg. Generates a manifest the page consults before
// falling through to the Worker.
//
// Run:   node tiles/build-cache.mjs
// Re-running is safe — already-on-disk tiles are skipped.
//
// Source of truth for the city list is space.js itself; we regex-parse
// CITY_LABELS and TIER1_CITIES from that file so we never have to keep two
// lists in sync.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TILES_DIR = path.join(REPO_ROOT, 'tiles');
const MANIFEST_PATH = path.join(TILES_DIR, 'manifest.json');
const SPACE_JS = path.join(REPO_ROOT, 'space.js');

const WORKER_BASE = 'https://satellite-imagery-proxy.esvela02.workers.dev/tile';
// Must match REFERER in worker/src/index.js — the worker spoofs this header
// upstream to Mapbox so URL-restricted tokens still work.
const REFERER = 'https://team2-satelliteimagery.minio-minio.auto.prod.osaas.io/';

// Zoom levels. At altitude 0.06 the slippy-tile engine asks for tiles
// around z13–14 over the immediate vicinity of the camera target. A 3×3
// grid at each zoom covers what's actually painted on the first frame
// of a city click; further panning falls through to the Worker.
const ZOOM_GRIDS = [
  { z: 13, half: 1 }, // 3×3 ≈ 14 km square
  { z: 14, half: 1 }, // 3×3 ≈ 7 km square
];

// Stay just under the Worker's 100/min/IP rate limit. Cache hits don't
// count, so subsequent runs of this script effectively run un-throttled.
const REQUEST_DELAY_MS = 700;

function parseSpaceJs(text) {
  // Pull the CITY_LABELS array body — find the literal then balance braces.
  const start = text.indexOf('const CITY_LABELS = [');
  if (start === -1) throw new Error('CITY_LABELS not found in space.js');
  const open = text.indexOf('[', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error('Unbalanced CITY_LABELS brackets');
  const body = text.slice(open + 1, end);
  const entries = [];
  // Match `{ lat: <num>, lng: <num>, name: '<name>' }` — names can be
  // single- or double-quoted and may contain non-ASCII characters and
  // diacritics.
  const re = /\{\s*lat:\s*(-?[\d.]+)\s*,\s*lng:\s*(-?[\d.]+)\s*,\s*name:\s*(['"])((?:\\.|(?!\3).)*)\3\s*\}/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    entries.push({
      lat: parseFloat(m[1]),
      lng: parseFloat(m[2]),
      name: m[4],
    });
  }
  if (entries.length === 0) throw new Error('No CITY_LABELS entries parsed');

  // Pull the TIER1_CITIES set body the same way.
  const t1Start = text.indexOf('const TIER1_CITIES = new Set([');
  if (t1Start === -1) throw new Error('TIER1_CITIES not found');
  const t1Open = text.indexOf('[', t1Start);
  let t1Depth = 0;
  let t1End = -1;
  for (let i = t1Open; i < text.length; i++) {
    if (text[i] === '[') t1Depth++;
    else if (text[i] === ']') {
      t1Depth--;
      if (t1Depth === 0) { t1End = i; break; }
    }
  }
  const t1Body = text.slice(t1Open + 1, t1End);
  const tier1 = new Set();
  const tre = /(['"])((?:\\.|(?!\1).)*)\1/g;
  let tm;
  while ((tm = tre.exec(t1Body)) !== null) tier1.add(tm[2]);
  if (tier1.size === 0) throw new Error('No TIER1_CITIES entries parsed');

  return { cities: entries, tier1 };
}

function latLngToTile(lat, lng, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y };
}

async function fileExists(p) {
  try { await fs.stat(p); return true; }
  catch { return false; }
}

async function fetchTile(z, x, y) {
  const url = `${WORKER_BASE}/${z}/${x}/${y}`;
  const res = await fetch(url, { headers: { Referer: REFERER } });
  if (res.status === 429) {
    throw Object.assign(new Error('rate limited'), { rateLimited: true });
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${z}/${x}/${y}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const spaceText = await fs.readFile(SPACE_JS, 'utf8');
  const { cities, tier1 } = parseSpaceJs(spaceText);

  const targets = cities.filter((c) => tier1.has(c.name));
  console.log(`Tier-1 cities: ${targets.length} / ${cities.length} total in space.js`);

  // Build the unique set of (z, x, y) tiles to fetch. Multiple cities can
  // share tiles at low zooms (rare at z13+ but possible for nearby pairs
  // like Tokyo/Yokohama if both were in the list).
  const tiles = new Map(); // key "z/x/y" → { z, x, y }
  for (const c of targets) {
    for (const { z, half } of ZOOM_GRIDS) {
      const { x: cx, y: cy } = latLngToTile(c.lat, c.lng, z);
      const max = 2 ** z;
      for (let dx = -half; dx <= half; dx++) {
        for (let dy = -half; dy <= half; dy++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || x >= max || y < 0 || y >= max) continue;
          tiles.set(`${z}/${x}/${y}`, { z, x, y });
        }
      }
    }
  }
  console.log(`${tiles.size} unique tiles across ${ZOOM_GRIDS.length} zoom levels.`);

  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  const ok = [];

  for (const [key, { z, x, y }] of tiles) {
    const tilePath = path.join(TILES_DIR, String(z), String(x), `${y}.jpg`);
    if (await fileExists(tilePath)) {
      skipped++;
      ok.push(key);
      continue;
    }

    let attempt = 0;
    while (true) {
      try {
        const body = await fetchTile(z, x, y);
        await fs.mkdir(path.dirname(tilePath), { recursive: true });
        await fs.writeFile(tilePath, body);
        fetched++;
        ok.push(key);
        if (fetched % 25 === 0) {
          console.log(`  fetched ${fetched} | skipped ${skipped} | failed ${failed}`);
        }
        break;
      } catch (err) {
        if (err.rateLimited && attempt < 5) {
          attempt++;
          const wait = 65_000;
          console.log(`  rate-limited, sleeping ${wait / 1000}s before retry…`);
          await sleep(wait);
          continue;
        }
        console.error(`  ${key} failed: ${err.message}`);
        failed++;
        break;
      }
    }
    await sleep(REQUEST_DELAY_MS);
  }

  // Manifest is just the sorted list of keys. The browser turns it into a
  // Set on load and uses presence to decide local-vs-Worker for each tile.
  ok.sort();
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(ok, null, 0) + '\n');

  console.log('\nDone.');
  console.log(`  Fetched ${fetched}, skipped ${skipped}, failed ${failed}.`);
  console.log(`  Manifest: ${path.relative(REPO_ROOT, MANIFEST_PATH)} (${ok.length} entries)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
