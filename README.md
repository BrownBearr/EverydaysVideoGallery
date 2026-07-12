# everdays-video

Full-screen ambient video wall. Plays a shuffled sequence of clips from a
Backblaze B2 bucket, each to completion, crossfading to the next. Square (1:1)
clips are letterboxed with a blurred ambient side-fill. A dimmed `day {name}`
label sits in the bottom-right.

No server — a static Vite build, deployed to Cloudflare Pages.

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
