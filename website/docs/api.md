# sejbosejbo.fyi JSON API

Base URL: `https://sejbosejbo.fyi/api/v1`

Build the Flutter app with:

```
--dart-define=API_BASE_URL=https://sejbosejbo.fyi
```

(the app appends `/api/v1` itself).

## Conventions

- All responses are `application/json; charset=utf-8`.
- Errors are `{"error": "human readable message"}` with the matching HTTP status.
- Every `429` carries a **`Retry-After`** header in seconds, and the same
  number as `retry_after_seconds` in the body. It's computed from the sliding
  window, so it's when a slot genuinely frees up - show "try again in N
  seconds" and schedule the retry rather than letting the user hammer it.
- `Cache-Control: no-store` on every response under `/api/v1` - don't cache
  vote counts or feeds client-side beyond your own app state.
- CORS is open (`Access-Control-Allow-Origin: *`) on `/api/v1` only. Native
  builds don't need it; the Flutter web build does.
- Timestamps are ISO 8601 UTC with a `Z` suffix, e.g. `2026-07-19T00:29:00Z`.
- Image URLs are always absolute (`https://sejbosejbo.fyi/uploads/...`).
- `lang` query param: `en` or `sl`, defaults to `en`. Drives `quote`,
  `random-phrase`, and validation-error text.
- No auth on any endpoint - the site is anonymous by design.

## The Post object

```json
{
  "id": 12,
  "title": "Microwaved a salad",
  "description": "It was warm. It was wrong.",
  "kind": "image",
  "image_url": "https://sejbosejbo.fyi/uploads/1784413785433-82067194ba2c0f24.jpg",
  "featured": false,
  "pinned": false,
  "created_at": "2026-07-19T00:29:00Z",
  "upvotes": 128,
  "downvotes": 6,
  "comment_count": 3,
  "my_vote": 1
}
```

- `kind` is `"image"` or `"story"`; `image_url` is `null` for text-only posts.
- `description` is `null`, not `""`, when empty.
- `featured` / `pinned` are real booleans.
- Hidden posts never appear anywhere in this API.
- `upvotes` / `downvotes` are raw counts - derive the score client-side as
  `upvotes - downvotes`; the API doesn't send a precomputed score.
- `comment_count` counts **visible** comments only - hiding a comment in
  admin drops the count immediately, so a card never advertises "3 comments"
  and then opens with two.

### `my_vote` - what this caller already voted

`1` | `-1` | `0`, echoing back the vote stored for your `X-Device-Id`.

**The field is present only when you send an `X-Device-Id` header** on the
request, and it appears on every read that returns posts or comments - feed,
list, detail, comment list - plus the responses to voting, uploading and
commenting.

The omission is deliberate and worth handling explicitly: absent means *"the
server doesn't know who you are"*, which is a different answer from `0`
(*"you haven't voted"*). Don't treat a missing field as unvoted.

Send the header on reads and you can drop client-side vote bookkeeping
entirely - the server is now the source of truth, so a reinstall, a cleared
cache or a second device all show the user's real votes instead of a blank
slate that lets them vote again.

## Reads

### `GET /feed?lang=en`

Everything the dashboard needs in one call. Does **not** increment the
website's human visitor counter.

```json
{
  "stats": { "visits": 1337, "uploads": 42, "days_since_last": 3 },
  "quote": "That's a certified Sejbosejbo.",
  "daily": { "...": "Post, or null" },
  "posts": [ "4 newest visible Posts, pinned first" ],
  "top": [ "3 highest (upvotes - downvotes) Posts of all time" ]
}
```

`days_since_last` is `null` when there are no posts yet.

### `GET /posts?page=1&per_page=24&sort=newest&lang=en`

```json
{ "items": [ "Posts" ], "page": 1, "per_page": 24, "has_next": true }
```

- `per_page` clamps to 50.
- `page` beyond the end returns `items: []`, `has_next: false` - not a 404.
- `sort`: `newest` (default, pure date order - **not** pinned-first, see
  below) | `top` (by score, `id` tie-break for stable pagination) |
  `featured` (only `featured: true`, newest first) | `pinned` (only
  `pinned: true`, newest first). Unknown values fall back to `newest`.

`pinned` stays in the Post object regardless of sort - it's just data, use it
to show a badge. `sort=newest` deliberately ignores it: a 19-day-old pinned
post outranking today's post in a tab labelled "newest" reads as broken to a
user even though it's doing what pinning asked for. Pin something and it
shows up in `sort=pinned`, not by jumping the newest queue. (The *website's*
own `/gallery` page still shows pinned posts first on its default view -
that's an intentional difference in the HTML, not a bug in the API.)

### `GET /posts/:id`

A single Post, or `404 {"error": "..."}`.

### `GET /random-phrase?lang=en`

```json
{ "phrase": "Certified Sejbosejbo" }
```

## Writes

### `POST /posts` — multipart/form-data

- `title` - required, trimmed, max 120 chars.
- `description` - optional, trimmed, max 1200 chars.
- `image` - optional, jpeg/png/gif/webp, max 8 MB.
- Need a title, and at least one of description or image.

`201` with the created Post. `400 {"error": "..."}` on validation failure.
**Rate limited: 5 uploads / 10 min per IP → `429`.**

### `POST /posts/:id/vote`

Header: `X-Device-Id: <a UUID or similar the app generates once and reuses>`
(8-128 chars, `[A-Za-z0-9_-]`). Missing/malformed → `400`.

Body:

```json
{ "value": 1 }
```

`1` = sej bo, `-1` = sej ne bo, `0` = withdraw. Anything else → `400`.

Returns the **full updated Post** so the app can replace its optimistic
guess with the real counts. One vote per `(post, device)` - voting again
updates rather than duplicates.

This is soft protection, not security: clearing app storage or forging the
header lets anyone re-vote. Treat counts as indicative, not authoritative.
**Rate limited: 60 votes / min per IP → `429`.**

### `POST /posts/:id/report`

Required by Google Play's User Generated Content policy and Apple's
Guideline 1.2 - both require an in-app way to flag objectionable content.
**The app must expose this**, not just the website.

Body:

```json
{ "reason": "spam", "details": "optional, max 500 chars" }
```

`reason` is one of `spam` | `inappropriate` | `harassment` | `copyright` |
`other`. Anything else → `400`. No `X-Device-Id` required - repeated
reports from the same device are a legitimate stronger signal, not abuse.

`201 {"ok": true}` on success, `404` if the post doesn't exist.
**Rate limited: 20 reports / hour per IP → `429`.**

Reports don't hide or remove anything automatically - they queue for a
human (site admin) to review at `/admin?filter=reported`.

### `GET /posts/:id/comments?page=1&per_page=50&sort=oldest`

```json
{ "items": [ { "id": 3, "post_id": 12, "body": "...", "created_at": "2026-08-14T01:41:04Z",
               "upvotes": 4, "downvotes": 0, "my_vote": 0 } ],
  "page": 1, "per_page": 50, "total": 3, "sort": "oldest", "has_next": false }
```

`per_page` clamps to 100. Hidden comments never appear.

`sort`: `oldest` (default, reading order) | `top` (by `upvotes - downvotes`,
oldest-first tie-break for stable pagination). Unknown values fall back to
`oldest`, and the response echoes the `sort` actually applied. The default
stays chronological on purpose - a thread is a conversation, and `top` is
the opt-in for long ones.

### `POST /posts/:id/comments`

Body: `{"body": "..."}` - required, trimmed, max 1000 chars.

`X-Device-Id` is **optional** here (unlike voting). Send it if you want
the client to be able to recognise its own comments later; comments are
anonymous either way and the server never exposes it.

`201` with the created comment, `400` on empty/too long, `404` if the
post is gone. **Rate limited: 15 comments / 10 min per IP.**

### `POST /comments/:id/vote`

Same contract as post voting. Header `X-Device-Id` is **required** here
(8-128 chars, `[A-Za-z0-9_-]`), unlike posting a comment.

Body: `{"value": 1}` - `1` sej bo, `-1` sej ne bo, `0` withdraw.

Returns the **updated comment** with fresh `upvotes` / `downvotes`.
One vote per `(comment, device)`; voting again updates rather than
duplicates, and deleting a comment cascades its votes away.
**Rate limited: 60 votes / min per IP.**

Comment objects carry `upvotes` and `downvotes`; the Post object gained
`comment_count`.

## Donations

- **iOS / Android / macOS**: use StoreKit / Play Billing, then confirm with
  the app's server-side verify endpoints below - store policy requires this
  and forbids linking out to Stripe from those builds.
- **Windows**: Stripe Checkout in the browser.

All three are **disabled (`503`) until the matching env vars are set** - see
`deploy/.env.example`. Nothing to change in the app; they'll start working
the moment the server is configured.

### `POST /donations/stripe/session`

Body: `{"tier_id": "small" | "medium" | "large"}` → `{"url": "https://checkout.stripe.com/..."}`

Amounts (`small`=€2, `medium`=€5, `large`=€15) come from a server-side map -
never trust a client-supplied amount.

### `POST /donations/apple/verify` / `POST /donations/google/verify`

Body: `{"product_id": "fyi.sejbosejbo.tip.small|medium|large", "token": "..."}`

`200` on a verified purchase, `400` on a receipt that doesn't check out,
`503` if that store's verification isn't configured yet.

## Deep links

`https://sejbosejbo.fyi/post/<id>` should open the app once it's registered.
`GET /.well-known/apple-app-site-association` and
`GET /.well-known/assetlinks.json` serve the association files once
`APPLE_TEAM_ID` / `ANDROID_CERT_SHA256` are set; until then they `404` and
shared links just open the website, which is a fine fallback.
