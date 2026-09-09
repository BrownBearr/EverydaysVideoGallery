import clipsData from './clips.json';
import styleData from './clip-styles.json';

type Clip = { id: number; name: string; w: number; h: number };

const CDN = (import.meta.env.VITE_CDN_BASE as string).replace(/\/$/, '');

const clips: Clip[] = [...clipsData.clips];

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

function fitsScreen(clip: Clip): boolean {
  const screenAR = window.innerWidth / window.innerHeight;
  const clipAR = clip.w / clip.h;
  if (!Number.isFinite(clipAR) || clipAR <= 0) return true; // unsized: fill, as before
  return Math.max(clipAR / screenAR, screenAR / clipAR) <= CROP_TOLERANCE;
}

// ── Feed ────────────────────────────────────────────────────────────────────
// A shuffled list of the clips matching the active styles, looped forever.

let feed: Clip[] = [];
let feedIndex = 0;

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
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

  const pool = activeStyles.size
    ? clips.filter((c) => activeStyles.has(styleOf.get(c.name) ?? ''))
    : clips;
  // Guard: an all-unknown filter shouldn't leave a blank screen.
  const usable = pool.length ? pool : clips;

  // A plain shuffle lets six pillarboxed clips land in a row and the frame
  // pulses. Shuffle the full-bleed and letterboxed sets separately, then weave
  // them, so the shape alternates while the order stays random.
  const full: Clip[] = [];
  const framed: Clip[] = [];
  for (const clip of usable) (fitsScreen(clip) ? full : framed).push(clip);

  feed = interleave(shuffle(full), shuffle(framed));
  breakStyleRuns(feed);
  feedIndex = 0;
}

function nextClip(): Clip {
  const clip = feed[feedIndex % feed.length];
  feedIndex++;
  return clip;
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

// Start "active" on B so the first activate(A) treats the still-empty B as its
// partner, rather than fighting itself over a single element.
let active = 1;
let pendingPreload = 0; // timeout id for the deferred partner preload

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
function preload(l: Layer, clip: Clip): void {
  l.clip = clip;
  l.main.dataset.name = clip.name;
  l.main.src = videoUrl(clip.name);
  l.main.load();
  setFit(l, !fitsScreen(clip));
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

  l.root.classList.add('active');
  partner.root.classList.remove('active');
  partner.main.pause();
  partner.ambient.pause();

  tryPlay(l);
  armWatchdog();

  // Dip the caption out, swap the number while it's invisible, bring it back —
  // so it dissolves along with the clip it names instead of snapping.
  dayEl.classList.add('swap');
  window.setTimeout(() => {
    dayEl.textContent = `day ${l.main.dataset.name ?? '—'}`;
    dayEl.classList.remove('swap');
  }, 300);

  // Reserve the next clip's order now, but don't point the partner at it until
  // the partner has finished fading out — otherwise its new first frame would
  // flash over the outgoing clip mid-crossfade. There's still the full length
  // of the incoming clip left to buffer, so the next swap stays hitch-free.
  const upcoming = nextClip();
  pendingPreload = window.setTimeout(() => preload(partner, upcoming), FADE_MS + 150);
}

// Swap to whichever layer is holding the preloaded next clip.
function advance(): void {
  window.clearInterval(stallTimer);
  activate(layers[1 - active]);
}

for (const l of layers) {
  // When a clip plays to the end, move on to the preloaded one.
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
      const contain = !fitsScreen(l.clip);
      if (contain === l.root.classList.contains('fit-contain')) continue;
      setFit(l, contain);
      if (contain && layers.indexOf(l) === active) void l.ambient.play().catch(() => {});
    }
  }, 200);
}

window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

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
  const params = new URLSearchParams(location.search);
  if (activeStyles.size) {
    params.set('styles', [...activeStyles].map(slug).join(','));
  } else {
    params.delete('styles');
  }
  params.delete('style');
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

// Apply a new selection live: cancel the stale preload, rebuild the feed, sync
// the URL, and crossfade straight into the new selection.
function applySelection(): void {
  window.clearTimeout(pendingPreload);
  rebuildFeed();
  syncUrl();
  renderChips();
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
});
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
rebuildFeed();
renderChips();
poke();
void keepAwake();

// Seed the first layer; its partner gets filled when we activate.
preload(layers[0], nextClip());
layers[0].main.addEventListener(
  'canplay',
  () => {
    activate(layers[0]);
  },
  { once: true },
);
