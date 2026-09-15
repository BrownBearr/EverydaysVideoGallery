import clipsData from './clips.json';
import styleData from './clip-styles.json';

type Clip = { id: number; name: string; w: number; h: number; d: number };

const CDN = (import.meta.env.VITE_CDN_BASE as string).replace(/\/$/, '');

const clips: Clip[] = [...clipsData.clips];

// ── Modes ───────────────────────────────────────────────────────────────────
// Two switches, each settable three ways: an explicit URL parameter (what a
// kiosk bookmark carries), a keypress while setting up, and localStorage so a
// screen that reboots mid-show comes back as it was. The URL always wins.

const params = new URLSearchParams(location.search);

function storedFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false; // private mode, or storage blocked — not worth failing over
  }
}

function storeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}


function initialFlag(param: string, key: string): boolean {
  const raw = params.get(param);
  if (raw === null) return storedFlag(key);
  // An explicit parameter both wins and sticks, so however the mode was last
  // chosen — kiosk URL or keypress — a plain reload comes back the same.
  const on = raw !== '0' && raw !== 'false';
  storeFlag(key, on);
  return on;
}

// Scale every clip up until it covers the display, cropping the overflow.
let fillMode = initialFlag('fill', 'everdays:fill');

// Derive the running order and the playhead from the clock, so every instance
// of the site is showing the same thing at the same moment.
let syncMode = initialFlag('sync', 'everdays:sync');

// ── Style tags (from daysofshivacanvas) ────────────────────────────────────
// Each clip carries one visual style; we join by numeric name and let the feed
// be filtered to any set of styles via ?styles= or the on-screen picker.

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const styleOf = new Map<string, string>();
const styleCount = new Map<string, number>();
for (const img of styleData.images) {
  styleOf.set(img.name, img.style);
  styleCount.set(img.style, (styleCount.get(img.style) ?? 0) + 1);
}

// Distinct styles, most populous first, each with its URL slug and clip count.
const stylesList = [...styleCount.entries()]
  .map(([style, count]) => ({ style, slug: slug(style), count }))
  .sort((a, b) => b.count - a.count);

const slugToStyle = new Map(stylesList.map((s) => [s.slug, s.style]));

// The set of active style labels. Empty ⇒ no filter (every clip plays).
const activeStyles = new Set<string>();

// ── Fit ─────────────────────────────────────────────────────────────────────
// Whether a clip fills the display or is shown whole inside blurred bars is a
// question about two aspect ratios, not about squareness. Dimensions come from
// the manifest (scripts/probe-dims.mjs) so the answer is known before the file
// loads — early enough to pick the ambient source and to sequence by shape.

// Crop this much and no more. On a 16:9 display the library splits cleanly:
// the 337 native 16:9 clips sit at mismatch 1.0 and the next nearest is 1.11,
// so anything in the gap works — 6% just keeps rounding error on the safe side.
const CROP_TOLERANCE = 1.06;

// `against` overrides the display's own ratio. Sync mode passes a fixed
// reference so two differently-shaped screens still derive the same order.
function fitsScreen(clip: Clip, against?: number): boolean {
  const screenAR = against ?? window.innerWidth / window.innerHeight;
  const clipAR = clip.w / clip.h;
  if (!Number.isFinite(clipAR) || clipAR <= 0) return true; // unsized: fill, as before
  return Math.max(clipAR / screenAR, screenAR / clipAR) <= CROP_TOLERANCE;
}

// Whether a clip is shown whole inside blurred bars. Fill mode says never: the
// clip is scaled up until it covers the screen and the overflow is cropped.
// Uniform scale — object-fit: cover — so nothing is ever distorted.
function wantsContain(clip: Clip): boolean {
  return !fillMode && !fitsScreen(clip);
}

// ── Feed ────────────────────────────────────────────────────────────────────
// A shuffled list of the clips matching the active styles, looped forever.

let feed: Clip[] = [];
let feedIndex = 0;

// Same generator as the sibling painterly renderer, for the same reason: a
// shuffle that can be reproduced exactly from a seed. Sync mode needs every
// instance to land on the identical order without being told it.
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function shuffle<T>(arr: T[], rand: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Spread the shorter list evenly through the longer one. Keeps both orders
// random while stopping either from arriving in a run.
function interleave(a: Clip[], b: Clip[]): Clip[] {
  if (b.length > a.length) [a, b] = [b, a];
  if (!b.length) return a;
  const gap = a.length / (b.length + 1);
  const out: Clip[] = [];
  let bi = 0;
  for (let i = 0; i < a.length; i++) {
    out.push(a[i]);
    while (bi < b.length && i + 1 >= gap * (bi + 1)) out.push(b[bi++]);
  }
  while (bi < b.length) out.push(b[bi++]);
  return out;
}

// One forward pass that pulls a nearby clip forward whenever two neighbours
// share a style. Bounded lookahead — this only has to soften runs, not
// guarantee their absence.
function breakStyleRuns(list: Clip[]): void {
  for (let i = 1; i < list.length; i++) {
    const prev = styleOf.get(list[i - 1].name);
    if (styleOf.get(list[i].name) !== prev) continue;
    for (let j = i + 1; j < Math.min(i + 8, list.length); j++) {
      if (styleOf.get(list[j].name) !== prev) {
        [list[i], list[j]] = [list[j], list[i]];
        break;
      }
    }
  }
}

// ?only=1095,406 — restrict the feed to named clips. Undocumented; it exists to
// put an awkward shape on screen on demand when checking the fit on a display.
function onlyFilter(): Set<string> {
  const raw = new URLSearchParams(location.search).get('only') ?? '';
  return new Set(raw.split(',').map((t) => t.trim()).filter(Boolean));
}

// The clips the current filter admits, in manifest order.
function currentPool(): Clip[] {
  const pool = activeStyles.size
    ? clips.filter((c) => activeStyles.has(styleOf.get(c.name) ?? ''))
    : clips;
  // Guard: an all-unknown filter shouldn't leave a blank screen.
  return pool.length ? pool : clips;
}

// Weave the full-bleed and letterboxed clips together. A plain shuffle lets six
// pillarboxed clips land in a row and the frame pulses; separating the two sets
// and interleaving them keeps the shape alternating while the order stays
// random. `against` fixes the reference ratio for sync mode — see syncOrder().
function orderPool(pool: Clip[], rand: () => number, against?: number): Clip[] {
  const full: Clip[] = [];
  const framed: Clip[] = [];
  for (const clip of pool) (fitsScreen(clip, against) ? full : framed).push(clip);

  const out = interleave(shuffle([...full], rand), shuffle([...framed], rand));
  breakStyleRuns(out);
  return out;
}

function rebuildFeed(): void {
  const only = onlyFilter();
  if (only.size) {
    const picked = clips.filter((c) => only.has(c.name));
    if (picked.length) {
      feed = shuffle(picked);
      feedIndex = 0;
      return;
    }
  }

  feed = orderPool(currentPool(), Math.random);
  feedIndex = 0;
}

function nextClip(): Clip {
  const clip = feed[feedIndex % feed.length];
  feedIndex++;
  return clip;
}

// ── Sync ────────────────────────────────────────────────────────────────────
// There is no server, so instances don't get told what to play — they each
// derive it. Given a shared anchor, a seeded shuffle and the durations in the
// manifest, the schedule is a pure function of the clock, and any number of
// screens land on the same clip at the same offset without talking.

// Fixed point the schedule counts from. Never change this: it would resequence
// every running instance at once.
const SYNC_ANCHOR = Date.UTC(2026, 0, 1);

// The order must not depend on the display, or a 16:9 projector and a portrait
// monitor would derive different feeds. Partition against 16:9 everywhere and
// let each screen render to its own shape.
const SYNC_REFERENCE_AR = 16 / 9;

// A local clock that is wrong by seconds is rare; one wrong by minutes isn't.
// Below this we trust the machine (it is NTP-synced far tighter than an HTTP
// Date header can measure), above it we apply the correction.
const CLOCK_SKEW_TOLERANCE_MS = 2000;

// How far the playhead may wander before we pull it back, and how often to look.
const DRIFT_TOLERANCE_S = 0.35;
const DRIFT_CHECK_MS = 15000;

let clockOffsetMs = 0;

function syncNow(): number {
  return Date.now() + clockOffsetMs;
}

// Only two instances running the same clips can be in step, so the filter is
// part of the key. Different filters simply run different schedules.
function syncKey(): string {
  return [...activeStyles].map(slug).sort().join(',');
}

type Schedule = { order: Clip[]; offsets: number[]; cycle: number };

let schedule: Schedule | null = null;
let scheduleCycle = -1;
let scheduleKey = '';

// Build (or reuse) the schedule for a cycle. Reshuffling per cycle keeps a
// 3-hour loop from being identical forever, and every instance reshuffles the
// same way because the cycle number is part of the seed.
function scheduleFor(cycle: number): Schedule {
  const key = syncKey();
  if (schedule && scheduleCycle === cycle && scheduleKey === key) return schedule;

  const rand = mulberry32((hashString(key) ^ cycle) >>> 0);
  const order = orderPool(currentPool(), rand, SYNC_REFERENCE_AR);

  const offsets: number[] = [];
  let acc = 0;
  for (const clip of order) {
    offsets.push(acc);
    acc += slotLength(clip);
  }

  schedule = { order, offsets, cycle: acc };
  scheduleCycle = cycle;
  scheduleKey = key;
  return schedule;
}

// Rightmost offset at or before `pos`.
function slotAt(offsets: number[], pos: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Where the wall should be right now: which clip, and how far into it.
function syncPosition(): { clip: Clip; index: number; offset: number } {
  // One pass to learn the cycle length, a second if the elapsed time crossed
  // into a different cycle once we knew it.
  let s = scheduleFor(scheduleCycle >= 0 ? scheduleCycle : 0);
  const elapsed = Math.max(0, syncNow() - SYNC_ANCHOR) / 1000;
  const cycle = Math.floor(elapsed / s.cycle);
  if (cycle !== scheduleCycle) s = scheduleFor(cycle);

  const pos = elapsed % s.cycle;
  const index = slotAt(s.offsets, pos);
  return { clip: s.order[index], index, offset: pos - s.offsets[index] };
}

// Adopt the sync feed and point feedIndex just past the clip that's due, so
// ordinary advance() keeps walking the same schedule.
function syncFeed(): { clip: Clip; offset: number } {
  const { clip, index, offset } = syncPosition();
  feed = (schedule as Schedule).order;
  feedIndex = index + 1;
  return { clip, offset };
}

// The local clock is usually better than anything an HTTP Date header can tell
// us — the header is quantised to the second. So this exists only to catch a
// machine whose clock is badly wrong, not to fine-tune a good one.
async function checkClock(): Promise<void> {
  try {
    const sent = Date.now();
    const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
    const header = res.headers.get('date');
    if (!header) return;
    const server = Date.parse(header);
    if (!Number.isFinite(server)) return;
    // Midpoint of the round trip is our best guess at "now" locally.
    const local = (sent + Date.now()) / 2;
    const skew = server - local;
    clockOffsetMs = Math.abs(skew) > CLOCK_SKEW_TOLERANCE_MS ? skew : 0;
  } catch {
    /* Offline or blocked — the local clock is all we have, and it's usually right. */
  }
}

// ── Playback (two-layer ping-pong crossfade) ────────────────────────────────

type Layer = {
  root: HTMLElement;
  main: HTMLVideoElement;
  ambient: HTMLVideoElement;
  clip: Clip | null;
};

function layer(id: string): Layer {
  const root = document.getElementById(id) as HTMLElement;
  return {
    root,
    main: root.querySelector('.main') as HTMLVideoElement,
    ambient: root.querySelector('.ambient') as HTMLVideoElement,
    clip: null,
  };
}

const layers: Layer[] = [layer('layerA'), layer('layerB')];
const dayEl = document.getElementById('day') as HTMLDivElement;
const gateEl = document.getElementById('gate') as HTMLDivElement;

// Durations live in index.html as custom properties so the CSS transitions and
// the JS timers can't drift apart. Read once — they don't change at runtime.
function readMs(prop: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return raw.endsWith('ms') ? n : n * 1000;
}

const FADE_MS = readMs('--fade', 1100);
const IDLE_MS = readMs('--idle', 4000);

// How long the active clip may sit at the same timestamp before we call it
// stalled. Comfortably longer than any buffering hiccup worth waiting through.
const STALL_MS = 6000;

// The crossfade eats into the end of a clip, so a very short one would be
// nothing but transition. Nothing in the library is under 4.6s today; this is
// here so adding a 2s clip later degrades quietly.
function fadeFor(duration: number): number {
  const fade = FADE_MS / 1000;
  if (!Number.isFinite(duration) || duration <= 0) return fade;
  return Math.min(fade, duration / 3);
}

// `timeupdate` only fires about every 250ms, so the swap can start up to that
// late — and then the outgoing clip reaches its own end before the fade is
// finished and freezes for the tail, which is the exact thing the crossfade is
// meant to stop. Begin far enough ahead that even the latest tick still leaves
// a full fade of video behind it.
const SWAP_LEAD_S = 0.4;

// Time a clip actually holds the screen: its length, less the overlap it hands
// to the next one. Sync schedules against the same figure so the derived
// position and real playback don't pull apart.
function slotLength(clip: Clip): number {
  return Math.max(0.1, clip.d - fadeFor(clip.d) - SWAP_LEAD_S);
}

// Start "active" on B so the first activate(A) treats the still-empty B as its
// partner, rather than fighting itself over a single element.
let active = 1;
let pendingPreload = 0; // timeout id for the deferred partner preload
let readyTimer = 0; // fallback timeout for a swap waiting on canplay
let swapping = false; // guards the pre-emptive crossfade against double-firing
let started = false; // true once anything has been put on screen

const HAVE_CURRENT_DATA = 2;

function videoUrl(name: string): string {
  return `${CDN}/${name}.mp4`;
}

// The fill is blurred past recognition, so it runs off the 480p preview the
// bucket already carries. Decoding the full-res file twice would put four HD
// streams on the machine during a crossfade for no visible gain.
function ambientUrl(name: string): string {
  return `${CDN}/${name}-480.mp4`;
}

// Attach or detach the blurred side-fill to match the layer's current fit.
function setFit(l: Layer, contain: boolean): void {
  l.root.classList.toggle('fit-contain', contain);
  if (contain) {
    const want = ambientUrl(l.main.dataset.name ?? '');
    if (l.ambient.src !== want) {
      l.ambient.src = want;
      l.ambient.load();
    }
  } else if (l.ambient.hasAttribute('src')) {
    l.ambient.pause();
    l.ambient.removeAttribute('src');
    l.ambient.load();
  }
}

// Point a layer at a clip and begin buffering. The shape is known from the
// manifest, so the fit is settled here rather than waiting on loadedmetadata.
function preload(l: Layer, clip: Clip, startAt = 0): void {
  l.clip = clip;
  l.main.dataset.name = clip.name;
  l.main.src = videoUrl(clip.name);
  l.main.load();
  setFit(l, wantsContain(clip));
  // currentTime before metadata is a no-op, so a mid-clip join has to wait for
  // the duration to be known.
  if (startAt > 0) {
    l.main.addEventListener('loadedmetadata', () => seekTo(l, startAt), { once: true });
  }
}

function seekTo(l: Layer, seconds: number): void {
  const d = l.main.duration;
  if (!Number.isFinite(d) || d <= 0) return;
  try {
    l.main.currentTime = Math.max(0, Math.min(seconds, d - 0.05));
  } catch {
    /* Seeking an unseekable/unready element — leave it at the start. */
  }
}

// ── Playback watchdog ───────────────────────────────────────────────────────
// `ended` is the normal way forward, but it never fires for a clip that stalls
// mid-buffer. Unattended, that's a black wall until someone notices — so we
// also watch the clock and move on if it stops advancing.

let stallTimer = 0;
let lastTime = -1;

function armWatchdog(): void {
  window.clearInterval(stallTimer);
  lastTime = -1;
  stallTimer = window.setInterval(() => {
    const v = layers[active].main;
    if (v.paused || v.ended) return;
    if (lastTime >= 0 && v.currentTime === lastTime) advance();
    else lastTime = v.currentTime;
  }, STALL_MS);
}

// ── Autoplay ────────────────────────────────────────────────────────────────
// A blocked play() used to fall straight through to advance(), which burned the
// whole feed in a fraction of a second. Give up after a few and ask for the one
// gesture the browser wants.

let playFailures = 0;

function tryPlay(l: Layer): void {
  void l.main
    .play()
    .then(() => {
      playFailures = 0;
      gateEl.classList.add('hidden');
    })
    .catch(() => {
      if (++playFailures >= 3) {
        gateEl.classList.remove('hidden');
        return;
      }
      advance();
    });
  if (l.root.classList.contains('fit-contain')) {
    l.ambient.currentTime = 0;
    void l.ambient.play().catch(() => {});
  }
}

// Bring a layer to the foreground: crossfade it in, fade its partner out, play
// it (plus its ambient fill if letterboxed), dissolve the day label, then queue
// the next clip on the partner.
function activate(l: Layer): void {
  const partner = layers[active];
  active = layers.indexOf(l);
  swapping = false;
  started = true;

  l.root.classList.add('active');
  partner.root.classList.remove('active');

  tryPlay(l);
  armWatchdog();

  // Dip the caption out, swap the number while it's invisible, bring it back —
  // so it dissolves along with the clip it names instead of snapping.
  dayEl.classList.add('swap');
  window.setTimeout(() => {
    dayEl.textContent = `day ${l.main.dataset.name ?? '—'}`;
    dayEl.classList.remove('swap');
  }, 300);

  // Reserve the next clip's order now, but leave the partner playing until the
  // crossfade is over — pausing it here is what used to turn every transition
  // into a dissolve from a frozen frame. Once it's invisible, stop it and point
  // it at the next clip; there's a full clip's length left to buffer, so the
  // next swap stays hitch-free.
  const upcoming = nextClip();
  pendingPreload = window.setTimeout(() => {
    partner.main.pause();
    partner.ambient.pause();
    preload(partner, upcoming);
  }, FADE_MS + 150);
}

// Swap to whichever layer is holding the preloaded next clip.
//
// Normally that layer was pointed at its clip a whole clip ago and is long
// since buffered, so this is immediate. Two paths aren't like that — a resync
// and a filter change both aim a layer at a new file and switch to it at once —
// and calling play() on an element still working through load() or a seek gets
// the play aborted, leaving a silent black layer. So wait for readiness when
// it isn't there yet.
function advance(): void {
  window.clearInterval(stallTimer);
  const next = layers[1 - active];
  // Nothing queued at all (a swap this early can only come from a resync).
  if (!next.clip) preload(next, nextClip());

  if (next.main.readyState >= HAVE_CURRENT_DATA) {
    activate(next);
    return;
  }
  const go = (): void => {
    next.main.removeEventListener('canplay', go);
    window.clearTimeout(readyTimer);
    activate(next);
  };
  next.main.addEventListener('canplay', go);
  // Don't hang forever if canplay never comes; the error/stall paths take over.
  readyTimer = window.setTimeout(go, 3000);
}

for (const l of layers) {
  // Begin the crossfade before the clip runs out, so both are still playing
  // while they overlap. Driven by the media clock rather than a timer, so a
  // clip that buffers mid-way doesn't fade early.
  l.main.addEventListener('timeupdate', () => {
    if (swapping || layers.indexOf(l) !== active) return;
    const d = l.main.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    if (d - l.main.currentTime <= fadeFor(d) + SWAP_LEAD_S) {
      swapping = true;
      advance();
    }
  });
  // Fallback: a clip that reaches the end without the above firing (a seek past
  // the trigger point, say) still moves on.
  l.main.addEventListener('ended', () => {
    if (layers.indexOf(l) === active) advance();
  });
  // A missing or broken clip. On deck, quietly swap in another; on screen, move
  // on immediately — otherwise `ended` never comes and the wall holds black.
  l.main.addEventListener('error', () => {
    if (layers.indexOf(l) === active) advance();
    else preload(l, nextClip());
  });
}

// ── Display changes ─────────────────────────────────────────────────────────
// The fit depends on the display's shape, so it has to survive the projector
// renegotiating resolution or the window moving between screens. Re-fit both
// layers in place; rebuilding the feed here would restart the sequence, so the
// new shape split waits for the next natural rebuild.

let resizeTimer = 0;
function onResize(): void {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    for (const l of layers) {
      if (!l.clip) continue;
      const contain = wantsContain(l.clip);
      if (contain === l.root.classList.contains('fit-contain')) continue;
      setFit(l, contain);
      if (contain && layers.indexOf(l) === active) void l.ambient.play().catch(() => {});
    }
  }, 200);
}

window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

// ── Holding sync ────────────────────────────────────────────────────────────
// Playback runs free between checks; this only pulls it back when it has
// actually wandered. A seek on every tick would be visible and pointless.

let driftTimer = 0;

function holdSync(): void {
  if (!syncMode) return;
  const l = layers[active];
  if (!l.clip || l.main.paused || swapping) return;

  const due = syncPosition();
  if (due.clip.name !== l.clip.name) {
    // On the wrong clip entirely — crossfade to the right one rather than cut.
    resyncNow();
    return;
  }
  if (Math.abs(l.main.currentTime - due.offset) > DRIFT_TOLERANCE_S) {
    seekTo(l, due.offset);
  }
}

// Jump the wall to wherever the schedule says it should be, via a normal
// crossfade so the correction doesn't read as a glitch.
function resyncNow(): void {
  window.clearTimeout(pendingPreload);
  const { clip, offset } = syncFeed();
  const partner = layers[1 - active];
  preload(partner, clip, offset);
  advance();
}

function startSyncHold(): void {
  window.clearInterval(driftTimer);
  if (syncMode) driftTimer = window.setInterval(holdSync, DRIFT_CHECK_MS);
}

// ── Curation: URL <-> active styles, live switching ─────────────────────────

function stylesFromUrl(): void {
  const params = new URLSearchParams(location.search);
  const raw = params.get('styles') ?? params.get('style') ?? '';
  activeStyles.clear();
  for (const token of raw.split(',')) {
    const style = slugToStyle.get(slug(decodeURIComponent(token.trim())));
    if (style) activeStyles.add(style);
  }
}

function syncUrl(): void {
  const next = new URLSearchParams(location.search);
  if (activeStyles.size) {
    next.set('styles', [...activeStyles].map(slug).join(','));
  } else {
    next.delete('styles');
  }
  next.delete('style');
  // Keep the address bar a complete description of the screen, so a configured
  // wall can just be bookmarked.
  if (fillMode) next.set('fill', '1');
  else next.delete('fill');
  if (syncMode) next.set('sync', '1');
  else next.delete('sync');
  const qs = next.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

// Apply a new selection live: cancel the stale preload, rebuild the feed, sync
// the URL, and crossfade straight into the new selection.
function applySelection(): void {
  window.clearTimeout(pendingPreload);
  syncUrl();
  renderChips();
  // The filter is part of the sync key, so changing it moves this screen onto a
  // different schedule — and back into step with anyone using the same filter.
  if (syncMode) {
    resyncNow();
    return;
  }
  rebuildFeed();
  const partner = layers[1 - active];
  preload(partner, nextClip());
  advance();
}

// ── Picker overlay ──────────────────────────────────────────────────────────

const pickerEl = document.getElementById('picker') as HTMLDivElement;
const chipsEl = document.getElementById('chips') as HTMLDivElement;
const allBtn = document.getElementById('allBtn') as HTMLButtonElement;
const pickerToggle = document.getElementById('pickerToggle') as HTMLButtonElement;

for (const s of stylesList) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.dataset.style = s.style;
  chip.innerHTML = `${s.style}<span class="n">${s.count}</span>`;
  chip.addEventListener('click', () => {
    if (activeStyles.has(s.style)) activeStyles.delete(s.style);
    else activeStyles.add(s.style);
    applySelection();
  });
  chipsEl.appendChild(chip);
}

function renderChips(): void {
  for (const chip of Array.from(chipsEl.children) as HTMLElement[]) {
    chip.classList.toggle('on', activeStyles.has(chip.dataset.style ?? ''));
  }
  allBtn.classList.toggle('on', activeStyles.size === 0);
}

allBtn.addEventListener('click', () => {
  activeStyles.clear();
  applySelection();
});

function setPicker(open: boolean): void {
  pickerEl.classList.toggle('hidden', !open);
}

pickerToggle.addEventListener('click', () => setPicker(pickerEl.classList.contains('hidden')));
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') setPicker(pickerEl.classList.contains('hidden'));
  else if (e.key === 'Escape') setPicker(false);
  else if (e.key === 'Enter') void toggleFullscreen();
  else if (e.key === 'z' || e.key === 'Z') setFillMode(!fillMode);
  else if (e.key === 's' || e.key === 'S') setSyncMode(!syncMode);
});

// ── Mode switching ──────────────────────────────────────────────────────────

// Re-fit both layers in place. Like the resize path, this deliberately doesn't
// rebuild the feed — that would restart the running order mid-show. The shape
// split refreshes at the next natural rebuild.
function setFillMode(on: boolean): void {
  fillMode = on;
  storeFlag('everdays:fill', on);
  syncUrl();
  for (const l of layers) {
    if (!l.clip) continue;
    const contain = wantsContain(l.clip);
    if (contain === l.root.classList.contains('fit-contain')) continue;
    setFit(l, contain);
    if (contain && layers.indexOf(l) === active) void l.ambient.play().catch(() => {});
  }
  toast(on ? 'fill on' : 'fill off');
}

function setSyncMode(on: boolean): void {
  syncMode = on;
  storeFlag('everdays:sync', on);
  syncUrl();
  startSyncHold();
  if (on) {
    void checkClock().then(() => {
      if (syncMode) resyncNow();
    });
  } else {
    // Leaving sync: carry on from here with a fresh random order.
    rebuildFeed();
  }
  toast(on ? 'sync on' : 'sync off');
}

// Both modes are invisible until the next swap, which is confusing when you're
// standing at the machine setting one. A brief confirmation costs nothing.
const toastEl = document.getElementById('toast') as HTMLDivElement;
let toastTimer = 0;

function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 1500);
}
// Click outside the panel closes it.
pickerEl.addEventListener('click', (e) => {
  if (e.target === pickerEl) setPicker(false);
});

// ── Gallery rest state ──────────────────────────────────────────────────────
// Left alone, the wall should be nothing but video: caption, filter button and
// cursor all fade out. Any input brings them back.

let idleTimer = 0;

function poke(): void {
  document.body.classList.remove('idle');
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    // Don't hide the chrome out from under someone using the picker.
    if (pickerEl.classList.contains('hidden')) document.body.classList.add('idle');
  }, IDLE_MS);
}

for (const evt of ['mousemove', 'pointerdown', 'keydown', 'touchstart', 'wheel']) {
  window.addEventListener(evt, poke, { passive: true });
}

// ── Kiosk ───────────────────────────────────────────────────────────────────

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    /* Denied or unsupported — the wall runs fine windowed. */
  }
}

// Hold the screen awake for the length of the show. The lock is dropped
// whenever the tab is backgrounded, so re-take it on the way back.
type WakeLockSentinel = EventTarget & { released: boolean };

let wakeLock: WakeLockSentinel | null = null;

async function keepAwake(): Promise<void> {
  const api = (navigator as Navigator & {
    wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> };
  }).wakeLock;
  if (!api) return; // Safari < 16.4 and friends
  try {
    const lock = await api.request('screen');
    wakeLock = lock;
    // Backgrounding the tab drops the lock; forget it so we re-take it later.
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch {
    /* Denied — nothing to fall back to but the OS setting. */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !wakeLock) void keepAwake();
});

// The one gesture a blocking browser wants, taken at gallery open.
gateEl.addEventListener('click', () => {
  playFailures = 0;
  gateEl.classList.add('hidden');
  void keepAwake();
  tryPlay(layers[active]);
});

// ── Start ────────────────────────────────────────────────────────────────────

stylesFromUrl();
renderChips();
poke();
void keepAwake();
syncUrl();

// Seed the first layer; its partner gets filled when we activate.
// In sync mode the schedule says which clip and how far in — so a screen opened
// mid-show joins already in step instead of starting the sequence over.
if (syncMode && !onlyFilter().size) {
  const { clip, offset } = syncFeed();
  preload(layers[0], clip, offset);
  startSyncHold();
  // If this machine's clock turns out to be badly wrong, let the ordinary drift
  // check put us right — it seeks when it can and only reseats the feed when it
  // must. Racing a hard resync against the first frame is how you get a black
  // screen at gallery open.
  void checkClock().then(() => {
    if (syncMode && started && clockOffsetMs !== 0) holdSync();
  });
} else {
  syncMode = false;
  rebuildFeed();
  preload(layers[0], nextClip());
}

// Whichever path armed layer A, it goes on screen as soon as it can play — and
// only once, so a resync that lands first isn't undone by a late canplay.
layers[0].main.addEventListener(
  'canplay',
  () => {
    if (!started) activate(layers[0]);
  },
  { once: true },
);
