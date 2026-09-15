// Serve the wall from this machine instead of the internet.
//
// Ten synced screens all play the same clip at the same moment, so they all
// pull the same file at once. A CDN doesn't help with that — the venue's uplink
// still carries ten copies. Downloading the library once and serving it over
// the LAN removes the internet from the critical path entirely: ten screens at
// full quality is ~48 Mbps, which is nothing for a switch or a decent router.
//
// Usage:
//   node scripts/serve-local.mjs --fetch              # download the library (720p)
//   node scripts/serve-local.mjs --fetch --quality 480 # ...the small copies instead
//   node scripts/serve-local.mjs                      # serve site + clips
//   node scripts/serve-local.mjs --port 8080
//
// --fetch is resumable: it skips anything already present and correctly sized,
// so an interrupted download can just be run again.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLIPS_DIR = path.join(ROOT, "local-clips");
const DIST = path.join(ROOT, "dist");
const MANIFEST = path.join(ROOT, "src", "clips.json");

function loadEnv(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv(".env.local");
loadEnv(".env");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const PORT = Number.parseInt(value("--port", "8080"), 10);
const QUALITY = value("--quality", "720");
const SMALL = QUALITY === "480" || QUALITY === "small";
const CDN = (process.env.VITE_CDN_BASE || "").replace(/\/$/, "");
const CONCURRENCY = 8;

const clips = JSON.parse(fs.readFileSync(MANIFEST, "utf8")).clips;

// Both names are served; --fetch decides which one is actually downloaded.
const namesFor = (c) => (SMALL ? [`${c.name}-480.mp4`] : [`${c.name}.mp4`, `${c.name}-480.mp4`]);

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// ── fetch ───────────────────────────────────────────────────────────────────

async function head(url) {
  const r = await fetch(url, { method: "HEAD" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Number.parseInt(r.headers.get("content-length") || "0", 10);
}

async function fetchAll() {
  if (!CDN) {
    console.error("Missing VITE_CDN_BASE — see .env.example.");
    process.exit(1);
  }
  fs.mkdirSync(CLIPS_DIR, { recursive: true });

  const wanted = [];
  for (const c of clips) for (const n of namesFor(c)) wanted.push(n);

  console.log(`Library: ${clips.length} clips -> ${wanted.length} files (${SMALL ? "480p" : "720p + 480p fill"})`);
  let done = 0, skipped = 0, failed = 0, bytes = 0;

  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < wanted.length) {
        const name = wanted[next++];
        const dest = path.join(CLIPS_DIR, name);
        try {
          const remote = await head(`${CDN}/${name}`);
          if (fs.existsSync(dest) && fs.statSync(dest).size === remote) {
            skipped++;
          } else {
            const r = await fetch(`${CDN}/${name}`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const buf = Buffer.from(await r.arrayBuffer());
            fs.writeFileSync(`${dest}.part`, buf);
            fs.renameSync(`${dest}.part`, dest);
            bytes += buf.length;
            done++;
          }
        } catch (err) {
          failed++;
          console.error(`  ! ${name}: ${err.message}`);
        }
        const n = done + skipped + failed;
        if (n % 25 === 0 || n === wanted.length) {
          process.stdout.write(`\r  ${n}/${wanted.length}  (${(bytes / 1e9).toFixed(2)} GB downloaded)`);
        }
      }
    }),
  );
  process.stdout.write("\n");
  console.log(`✓ ${done} downloaded, ${skipped} already present, ${failed} failed.`);
  const total = fs.readdirSync(CLIPS_DIR).reduce((s, f) => s + fs.statSync(path.join(CLIPS_DIR, f)).size, 0);
  console.log(`  ${CLIPS_DIR} — ${(total / 1e9).toFixed(2)} GB`);
  if (failed) process.exit(1);
}

// ── serve ───────────────────────────────────────────────────────────────────

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".mp4": "video/mp4", ".jpg": "image/jpeg", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2" };

// Video needs byte ranges — without 206 support seeking doesn't work at all.
function sendFile(req, res, file) {
  const stat = fs.statSync(file);
  const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;
  const headers = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    // Served off a local disk and never changing during a show — let each screen
    // cache hard so a replay costs nothing at all.
    "Cache-Control": "public, max-age=31536000, immutable",
  };

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number.parseInt(m[1], 10) : 0;
    let end = m && m[2] ? Number.parseInt(m[2], 10) : stat.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
      if (start >= stat.size) {
        res.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      end = Math.min(end, stat.size - 1);
    }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Length": end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": stat.size });
  fs.createReadStream(file).pipe(res);
}

function serve() {
  if (!fs.existsSync(DIST)) {
    console.error("No dist/ — run `npm run build` first.");
    process.exit(1);
  }
  const files = fs.existsSync(CLIPS_DIR) ? fs.readdirSync(CLIPS_DIR).filter((f) => f.endsWith(".mp4")) : [];
  if (!files.length) {
    console.error("No clips in local-clips/ — run with --fetch first.");
    process.exit(1);
  }
  // A 480p-only library can't serve the 720p sources, and a screen that starts
  // on those would 404 its way down to them. Say so, and put it in the URL.
  const only480 = files.every((f) => f.endsWith("-480.mp4"));
  const haveClips = files.length;

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "range" });
      res.end();
      return;
    }
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    // Anything under /clips/ comes from the downloaded library; the rest is the site.
    const rel = url.startsWith("/clips/") ? url.slice("/clips/".length) : url;
    const base = url.startsWith("/clips/") ? CLIPS_DIR : DIST;
    // Keep the path inside its directory.
    const target = path.resolve(base, "." + path.posix.resolve("/", rel));
    if (!target.startsWith(base)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    let file = target;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(DIST, "index.html"); // SPA-ish fallback
      if (url.startsWith("/clips/")) {
        res.writeHead(404, { "Access-Control-Allow-Origin": "*" }).end("not found");
        return;
      }
    }
    try {
      sendFile(req, res, file);
    } catch {
      res.writeHead(500).end("error");
    }
  });

  server.listen(PORT, () => {
    const addrs = localAddresses();
    const host = addrs[0] || "localhost";
    console.log(`\nServing ${haveClips} clip files from ${CLIPS_DIR}`);
    console.log(`        and the built site from ${DIST}\n`);
    console.log("Open this on each screen:\n");
    const q = only480 ? "&quality=480" : "";
    for (const a of addrs) {
      console.log(`    http://${a}:${PORT}/?sync=1${q}&cdn=http://${a}:${PORT}/clips`);
    }
    if (!addrs.length) console.log(`    http://localhost:${PORT}/?sync=1${q}&cdn=http://localhost:${PORT}/clips`);
    if (only480) console.log(`\n  (480p-only library, so quality is pinned — re-fetch without --quality 480 for full res.)`);
    console.log(`\n  Add &fill=1 for full-bleed. Every screen must use the same URL to stay in sync.`);
    console.log(`  Ctrl-C to stop.\n`);
    void host;
  });
}

if (flag("--fetch")) await fetchAll();
else serve();
