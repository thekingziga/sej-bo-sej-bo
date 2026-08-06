# sejbosejbo.fyi

A deliberately simple chaotic meme website for declaring things officially Sejbosejbo.

## Run Locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Admin

The hidden admin page is `/admin`.

Set the password before deploying:

```bash
ADMIN_PASSWORD="change-this" SESSION_SECRET="a-long-random-string" npm start
```

If `ADMIN_PASSWORD` is not set, the local default is `sejbosejbo`.

## Data

- SQLite database: `data/sejbosejbo.sqlite`
- Uploaded images/GIFs: `uploads/`

Both are ignored by git so the site can keep its local archive separate from the code.

## JSON API

Everything under `/api/v1` is documented in full in
[`docs/api.md`](docs/api.md) - built for a companion app (iOS/Android/macOS/
Windows), same origin as the website, CORS-open, no auth. Quick orientation:

- `GET /api/v1/feed`, `GET /api/v1/posts`, `GET /api/v1/posts/:id`,
  `GET /api/v1/random-phrase` - reads, safe to hit from anywhere.
- `POST /api/v1/posts` - upload (multipart), rate limited per IP.
- `POST /api/v1/posts/:id/vote` - sej bo / sej ne bo, keyed by an
  `X-Device-Id` header the client mints itself. Soft protection only, not an
  auth system - anyone can reset local storage and vote again.
- `POST /api/v1/donations/*` and `/api/v1/webhooks/stripe` - disabled (503)
  until the Stripe/Apple/Google env vars below are set.

Rate limiting keys off the real client IP, which Express derives from
`X-Forwarded-For` set by HAProxy (`app.set("trust proxy", 1)` in
`server.js`) - this domain sits behind pfSense/HAProxy directly, not
Cloudflare, so HAProxy must have `option forwardfor` enabled on the frontend
or backend handling this site, and Node's port must not be reachable except
through HAProxy. See `lib/ip.js` for why.

## Branding Assets

Live in `public/` and are baked into the image by the Dockerfile's `COPY public ./public`:

- `logo.png` (420x420) - topbar mark, hero, and `og:image` for link previews
- `apple-touch-icon.png` (180x180) - iOS home screen
- `favicon.png` (32x32) - browser tab

To swap the logo, replace all three and rebuild. They are generated from one square
source PNG with a transparent background:

```bash
sips -Z 420 source.png --out public/logo.png
sips -Z 180 source.png --out public/apple-touch-icon.png
sips -Z 32  source.png --out public/favicon.png
```

## Updating A Running Deployment

Code and data are fully separate, so shipping new code never touches the archive:

- Code (`server.js`, `public/`) is baked into the image at build time.
- Data lives in bind mounts on the host - `./data` and `./uploads` next to
  `docker-compose.yml` - so it is never inside the container.

Recreating the container therefore keeps every upload, the visit counter, and the
admin password. The schema uses `CREATE TABLE IF NOT EXISTS`, so existing rows are
left alone on start.

Build and push the new image (see the Docker Hub section), then on the Pi:

```bash
cd /home/pidocker/sejbosejbo && docker compose pull && docker compose up -d
```

Notes:

- Do not delete `/home/pidocker/sejbosejbo/data` or `/uploads` - that is the archive.
  The `votes` and `donations` tables live in the same SQLite file, so nothing new
  needs its own volume.
- Keep `SESSION_SECRET` in `.env` unchanged, otherwise everyone (including admin)
  gets logged out.
- `deploy/rpi-prepare.js` only wipes the *build* folder, never the run folder, and
  it will not overwrite an existing `.env`.
- `/public` is served with a 1 hour cache, so a phone that visited recently may need
  a hard refresh before CSS or logo changes show up. `/api/v1/*` always sends
  `Cache-Control: no-store`.
- New optional env vars for donations and app links live in `.env` - see
  `deploy/.env.example`. Any left blank simply disable that feature (503 on the
  donation endpoints, 404 on the `.well-known` files) rather than breaking startup.

## Admin Panel

`/admin` has three sections now, not just the upload table:

- **dashboard** - the upload table, with an `all` / `reported` filter. Reported
  posts show a per-reason tally and a `clear` button that dismisses the
  report(s) without hiding or deleting the post itself.
- **metrics** - visitor/post/vote counts, reports filed all-time vs currently
  outstanding (filed survives a `clear`, outstanding doesn't), and top posts by
  score.
- **settings** - who gets emailed when a post is reported. This is the only
  admin-configurable setting stored in the database (`settings` table) rather
  than an env var, since it's a preference, not a secret.

Report emails need SMTP credentials in `.env` (`SMTP_HOST`, `SMTP_USER`,
`SMTP_PASS` at minimum) - see `deploy/.env.example`. Leave them unset and
reporting still works, it just won't email anyone; `/admin/settings` shows
whether SMTP is currently configured.

## Docker

Build locally:

```bash
docker build -t sejbosejbo:local .
```

Run locally:

```bash
docker run -d \
  --name sejbosejbo \
  -p 3000:3000 \
  -e ADMIN_PASSWORD="change-this-password" \
  -e SESSION_SECRET="change-this-to-a-long-random-string" \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/uploads:/app/uploads" \
  sejbosejbo:local
```

The container needs two persistent folders:

- `/app/data` for the SQLite database
- `/app/uploads` for uploaded images/GIFs

Health check:

```bash
curl http://localhost:3000/health
```

## Docker Hub Build And Push

Published image:

```text
thekingziga/sejbosejbo:latest
thekingziga/sejbosejbo:1.4.1
```

The published tags are `linux/arm64` only, because the image is built natively on
the Pi rather than cross-built from a Mac. That is the only platform the Pi needs.

Copy the source to the Pi's build folder (run from the project root on the Mac):

```bash
rsync -av --exclude node_modules --exclude data --exclude uploads --exclude .git ./ pidocker@192.168.69.13:/home/pidocker/docker_image_maker/sejbosejbo/
```

Then on the Pi, build and push:

```bash
cd /home/pidocker/docker_image_maker/sejbosejbo && docker build -t thekingziga/sejbosejbo:1.4.1 -t thekingziga/sejbosejbo:latest .
```

```bash
docker login && docker push thekingziga/sejbosejbo:1.4.1 && docker push thekingziga/sejbosejbo:latest
```

Because the build already leaves the image on the Pi, deploying needs no pull:

```bash
cd /home/pidocker/sejbosejbo && docker compose up -d
```

### Cross-building from a Mac instead

Only needed if the image should also run on `linux/amd64`. Requires Docker Desktop
or OrbStack installed locally:

```bash
docker buildx create --use --name sejbosejbo-builder
docker buildx build --platform linux/amd64,linux/arm64 -t thekingziga/sejbosejbo:latest -t thekingziga/sejbosejbo:1.4.1 --push .
```

If the Pi ever runs a 32-bit OS, add `linux/arm/v7`.

## Raspberry Pi Compose Layout

Recommended folder:

```text
/home/pidocker/sejbosejbo/
  docker-compose.yml
  .env
  data/
  uploads/
```

Example setup:

```bash
mkdir -p /home/pidocker/sejbosejbo/data /home/pidocker/sejbosejbo/uploads
cd /home/pidocker/sejbosejbo
cp /path/to/deploy/docker-compose.yml ./docker-compose.yml
cp /path/to/deploy/.env.example ./.env
nano .env
docker compose up -d
```
