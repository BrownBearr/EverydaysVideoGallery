import clipsData from './clips.json';

type Clip = { id: number; name: string };

const CDN = (import.meta.env.VITE_CDN_BASE as string).replace(/\/$/, '');

// Fisher-Yates shuffle — a different order each session.
const clips: Clip[] = [...clipsData.clips];
for (let i = clips.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [clips[i], clips[j]] = [clips[j], clips[i]];
}

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

let clipIndex = 0;
// Start "active" on B so the first activate(A) treats the still-empty B as its
// partner, rather than fighting itself over a single element.
let active = 1;

function nextClip(): Clip {
  const clip = clips[clipIndex % clips.length];
  clipIndex++;
  return clip;
}

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
  window.setTimeout(() => preload(partner, upcoming), FADE_MS + 150);
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

// Seed the first layer; its partner gets filled when we activate.
preload(layers[0], nextClip());
layers[0].main.addEventListener(
  'canplay',
  () => {
    activate(layers[0]);
  },
  { once: true },
);
