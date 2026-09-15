# everdays-video

Full-screen ambient video wall. Plays a shuffled sequence of clips from a
Backblaze B2 bucket, each to completion, crossfading to the next. Clips whose
shape doesn't match the display are shown whole inside a blurred ambient fill.
A dimmed `day {name}` label sits in the bottom-right, and fades out along with
the rest of the chrome once the wall is left alone.

No server — a static Vite build, deployed to Cloudflare Pages.

## Running it in a gallery

| Key | |
|---|---|
| `Enter` | toggle fullscreen |
| `f` | open/close the style picker |
| `Esc` | close the picker |
| `z` | fill mode on/off |
| `s` | sync mode on/off |

Both modes also have buttons under **display** at the top of the filter panel
(`f`), which is the place to find them if you don't know the shortcut — the
panel names the shortcut on each button and says what the mode is doing to this
particular screen.

Both modes are also settable in the URL — `?fill=1&sync=1` — which is what a
kiosk bookmark should carry, and whichever way you set one it's remembered
locally, so a screen that reboots mid-show comes back as it was. An explicit
parameter always beats the remembered value (`?fill=0` forces it off).

Everything on screen — caption, filter button, mouse cursor — fades out after
4s of no input and returns on any movement or keypress. The picker never hides
itself out from under you.

The wall is built to be left alone: it holds a screen wake lock so the display
can't sleep, skips a clip that 404s or stalls rather than freezing on it, and
if a browser refuses to autoplay it shows a *touch to begin* panel instead of
racing through the feed. One tap at opening covers the whole run.

## Aspect ratios

Clip shapes in the library range from 406×720 to 1520×720 (most sources are
720p; some newer clips are 1920×1080 or 1920×1920). `src/clips.json`
carries each clip's pixel dimensions so the renderer knows the shape before the
file loads. A clip fills the screen when its aspect ratio is within
`CROP_TOLERANCE` (6%) of the display's; otherwise it is shown whole and a
blurred, dimmed copy of itself lights the bars. That decision is re-taken on
resize, so moving the window between a monitor and a projector — or the
projector renegotiating resolution — re-fits without interrupting the clip.

The feed shuffles full-bleed and letterboxed clips separately and weaves them,
so the frame shape alternates instead of arriving in long runs of one shape.

To put an awkward shape on screen on demand when checking a display:
`?only=1095` (comma-separated clip names).

### Fill mode (`z`, `?fill=1`)

Scales every clip up until it covers the screen and crops the overflow — one
uniform scale, so nothing is ever distorted. No bars, no ambient fill, no
vignette. What it costs depends on how far the clip is from the display: an
ultrawide clip loses about 16% of its width, a 4:3 clip 25%, and a 406×720
portrait clip keeps only 32% of its frame. Off by default.

## Sync mode (`s`, `?sync=1`)

Every instance of the site plays the same clip at the same moment, so a
projector and a monitor across the room stay together.

There's no server involved. Each instance *derives* the schedule: a fixed
anchor date, a seeded shuffle, and the durations in `src/clips.json` are enough
for any number of screens to compute the same running order and the same
playhead independently. A screen opened mid-show joins mid-clip, already in
step, and the position is re-checked every 15s — a small drift is corrected with
a seek, a large one with an ordinary crossfade, never a hard cut. Measured
agreement between two instances is well under a second.

Two things follow from that design:

- **The style filter is part of the schedule.** Two screens with the same filter
  are in step; different filters run different schedules. The picker keeps
  working while synced.
- **Fill mode and screen shape don't affect it.** The order is derived against a
  fixed 16:9 reference, so a portrait monitor in fill mode still shows the same
  clip at the same moment as a 16:9 projector.

### If a screen struggles

The clips are served straight from the bucket, which sends no cache headers and
sits behind no CDN, so the first read of a file is a full round trip. Every clip
also exists as a 480p copy (5–20× smaller), and a screen that can't keep the
720p sources arriving in time falls back to those on its own rather than showing
black. It climbs back up after a sustained clean run.

Pin it with `?quality=720` or `?quality=480` for a machine you already know
about. A screen on 480p stays in sync with one on 720p — the schedule is built
from the manifest, not from whichever file a given screen happens to be playing.

The local clock is trusted by default — a gallery machine is NTP-synced far
tighter than an HTTP `Date` header can measure. Server time is consulted only to
catch a clock that is wrong by more than two seconds.

## Clip dimensions

`src/clips.json` needs `w`/`h` and duration `d` on every entry. After adding
clips, run:

```
npm run clips:dims
```

It ffprobes anything missing dimensions or duration straight off the CDN (the
bucket is public-read, so no credentials needed) and writes them back. `--force`
re-probes everything.

Duration matters as much as size: the crossfade has to start before a clip ends,
and sync mode builds its schedule from the whole library's running order without
loading a file.

## Develop

```
npm install
npm run dev
```

## Environment

`.env` (committed, public) sets the B2 bucket base URL:

```
VITE_CDN_BASE=https://daysofshiva-source.s3.us-east-005.backblazeb2.com
```

The bucket is public-read, so no secrets are needed at runtime. `.env.local`
(gitignored) holds the B2 key id / app key used only by offline tooling.

## Deploy — Cloudflare Pages

- **Framework preset:** None / Vite
- **Build command:** `npm run build`
- **Build output directory:** `dist`
- **Environment variable:** `VITE_CDN_BASE` (same value as `.env`)
- **Custom domain:** `video.shivav.space` (CNAME managed by Cloudflare)
