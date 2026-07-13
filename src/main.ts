import clipsData from './clips.json';
import styleData from './clip-styles.json';

type Clip = { id: number; name: string };

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

function rebuildFeed(): void {
  const pool = activeStyles.size
    ? clips.filter((c) => activeStyles.has(styleOf.get(c.name) ?? ''))
    : clips;
  // Guard: an all-unknown filter shouldn't leave a blank screen.
  feed = shuffle([...(pool.length ? pool : clips)]);
  feedIndex = 0;
}

function nextClip(): Clip {
  const clip = feed[feedIndex % feed.length];
  feedIndex++;
  return clip;
}

// ── Playback (two-layer ping-pong crossfade) ────────────────────────────────

type Layer = { root: HTMLElement; main: HTMLVideoElement; ambient: HTMLVideoElement };

function layer(id: string): Layer {
  const root = document.getElementById(id) as HTMLElement;
  return {
    root,
    main: root.querySelector('.main') as HTMLVideoElement,
    ambient: root.querySelector('.ambient') as HTMLVideoElement,
  };
}

const layers: Layer[] = [layer('layerA'), layer('layerB')];
const dayEl = document.getElementById('day') as HTMLDivElement;

// Must match the .layer opacity transition in index.html, plus a little slack.
const FADE_MS = 1100;

// Start "active" on B so the first activate(A) treats the still-empty B as its
// partner, rather than fighting itself over a single element.
let active = 1;
let pendingPreload = 0; // timeout id for the deferred partner preload

function videoUrl(name: string): string {
  return `${CDN}/${name}.mp4`;
}

// A clip counts as square when its width and height are within 5% of equal.
function isSquare(v: HTMLVideoElement): boolean {
  return v.videoHeight > 0 && Math.abs(v.videoWidth / v.videoHeight - 1) < 0.05;
}

// Point a layer at a clip and begin buffering. The ambient copy stays unloaded
// until we learn (from metadata) that the clip is square and needs side fill.
function preload(l: Layer, clip: Clip): void {
  l.root.classList.remove('square');
  l.ambient.removeAttribute('src');
  l.ambient.load();
  l.main.dataset.name = clip.name;
  l.main.src = videoUrl(clip.name);
  l.main.load();
}

// Bring a layer to the foreground: crossfade it in, fade its partner out, play
// it (plus its ambient fill if square), update the day label, then queue the
// next clip on the partner.
function activate(l: Layer): void {
  const partner = layers[active];
  active = layers.indexOf(l);

  l.root.classList.add('active');
  partner.root.classList.remove('active');
  partner.main.pause();
  partner.ambient.pause();

  void l.main.play().catch(() => {
    /* If the browser blocks playback, skip ahead so we never stall. */
    advance();
  });
  if (l.root.classList.contains('square')) {
    l.ambient.currentTime = 0;
    void l.ambient.play().catch(() => {});
  }

  dayEl.classList.add('swap');
  dayEl.textContent = `day ${l.main.dataset.name ?? '—'}`;
  void dayEl.offsetWidth; // commit the 0-opacity state before it transitions
  dayEl.classList.remove('swap');

  // Reserve the next clip's order now, but don't point the partner at it until
  // the partner has finished fading out — otherwise its new first frame would
  // flash over the outgoing clip mid-crossfade. There's still the full length
  // of the incoming clip left to buffer, so the next swap stays hitch-free.
  const upcoming = nextClip();
  pendingPreload = window.setTimeout(() => preload(partner, upcoming), FADE_MS + 150);
}

// Swap to whichever layer is holding the preloaded next clip.
function advance(): void {
  activate(layers[1 - active]);
}

for (const l of layers) {
  // Once we know the dimensions, wire up the ambient side-fill for square clips.
  l.main.addEventListener('loadedmetadata', () => {
    if (isSquare(l.main)) {
      l.root.classList.add('square');
      l.ambient.src = l.main.src;
      l.ambient.load();
    } else {
      l.root.classList.remove('square');
    }
  });
  // When a clip plays to the end, move on to the preloaded one.
  l.main.addEventListener('ended', () => {
    if (layers.indexOf(l) === active) advance();
  });
  // A missing/broken clip on the on-deck layer: re-point it at another clip.
  l.main.addEventListener('error', () => {
    if (layers.indexOf(l) !== active) preload(l, nextClip());
  });
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
});
// Click outside the panel closes it.
pickerEl.addEventListener('click', (e) => {
  if (e.target === pickerEl) setPicker(false);
});

// ── Start ────────────────────────────────────────────────────────────────────

stylesFromUrl();
rebuildFeed();
renderChips();

// Seed the first layer; its partner gets filled when we activate.
preload(layers[0], nextClip());
layers[0].main.addEventListener(
  'canplay',
  () => {
    activate(layers[0]);
  },
  { once: true },
);
