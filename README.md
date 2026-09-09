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

Everything on screen — caption, filter button, mouse cursor — fades out after
4s of no input and returns on any movement or keypress. The picker never hides
itself out from under you.

The wall is built to be left alone: it holds a screen wake lock so the display
can't sleep, skips a clip that 404s or stalls rather than freezing on it, and
if a browser refuses to autoplay it shows a *touch to begin* panel instead of
racing through the feed. One tap at opening covers the whole run.

## Aspect ratios

Clip shapes in the library range from 406×720 to 1520×720. `src/clips.json`
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

## Clip dimensions

`src/clips.json` needs `w`/`h` on every entry. After adding clips, run:

```
npm run clips:dims
```

It ffprobes anything missing dimensions straight off the CDN (the bucket is
public-read, so no credentials needed) and writes them back. `--force` re-probes
everything.

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
