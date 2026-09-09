// Bake each clip's pixel dimensions into src/clips.json.
//
// The renderer decides how to fit a clip (fill the screen, or show it whole with
// an ambient side-fill) from its aspect ratio. Reading that from the <video>
// element means waiting for loadedmetadata, which is too late to pick a source
// for the ambient layer or to sequence the feed by shape — so we probe once,
// offline, and ship the numbers in the manifest.
//
// Reads VITE_CDN_BASE from .env / .env.local. The bucket is public-read, so no
// B2 credentials are needed here.
//
// Usage:
//   node scripts/probe-dims.mjs           # fill in clips that have no w/h yet
//   node scripts/probe-dims.mjs --force   # re-probe every clip
//   node scripts/probe-dims.mjs --limit 5 # probe at most 5 (test)

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "src", "clips.json");

// --- minimal .env loader (no dependency); .env.local wins over .env ---
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

const FFPROBE =
  process.env.FFPROBE_PATH ||
  (fs.existsSync("C:/ffmpeg/bin/ffprobe.exe") ? "C:/ffmpeg/bin/ffprobe.exe" : "ffprobe");

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");
const limitArg = process.argv.find((a, i) => process.argv[i - 1] === "--limit");
const LIMIT = limitArg ? Number.parseInt(limitArg, 10) : Infinity;

const CDN = (process.env.VITE_CDN_BASE || "").replace(/\/$/, "");
if (!CDN) {
  console.error("Missing VITE_CDN_BASE — add it to .env, see .env.example.");
  process.exit(1);
}

// How many probes to keep in flight. Each is a ranged HTTP read of the moov
// atom, so this is bounded by round-trips, not bandwidth.
const CONCURRENCY = 16;

async function probe(name) {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    `${CDN}/${name}.mp4`,
  ]);
  const [w, h] = stdout.trim().split("x").map(Number);
  if (!w || !h) throw new Error(`no video stream (got "${stdout.trim()}")`);
  return { w, h };
}

// Run `worker` over `items` with a fixed number of concurrent slots.
async function pool(items, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(runners);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const todo = manifest.clips
  .filter((c) => FORCE || !c.w || !c.h)
  .slice(0, LIMIT === Infinity ? undefined : LIMIT);

if (!todo.length) {
  console.log(`✓ All ${manifest.clips.length} clips already have dimensions (--force to re-probe).`);
  process.exit(0);
}

console.log(`Probing ${todo.length} clip${todo.length === 1 ? "" : "s"} at ${CONCURRENCY}×…`);

let done = 0;
const failed = [];

await pool(todo, async (clip) => {
  try {
    const { w, h } = await probe(clip.name);
    clip.w = w;
    clip.h = h;
  } catch (err) {
    failed.push(`${clip.name}: ${err.message.split("\n")[0]}`);
  }
  if (++done % 25 === 0 || done === todo.length) {
    process.stdout.write(`\r  ${done}/${todo.length}`);
  }
});
process.stdout.write("\n");

// Keep the field order stable so the diff stays readable.
manifest.clips = manifest.clips.map(({ id, name, w, h }) => ({ id, name, w, h }));
fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

const sized = manifest.clips.filter((c) => c.w && c.h).length;
console.log(`✓ Wrote src/clips.json — ${sized}/${manifest.clips.length} clips sized.`);
if (failed.length) {
  console.error(`\n${failed.length} failed:`);
  for (const f of failed) console.error(`  ${f}`);
  process.exit(1);
}
