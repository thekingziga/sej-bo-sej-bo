const fs = require("fs");

const express = require("express");

const i18n = require("./i18n");
const { statements, castVote, castCommentVote, fileReport, addComment } = require("./db");
const { sendReportNotification } = require("./mail");
const ai = require("./ai");
const { getOrigin, getTotalVisits, getDailyUpload, daysSince, toIsoUtc } = require("./util");
const { getClientIp } = require("./ip");
const { createRateLimiter } = require("./rateLimit");
const { serializePost } = require("./serialize");
const { upload, kindForMime } = require("./upload");
const donations = require("./donations");

const router = express.Router();

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const REPORT_REASONS = ["spam", "inappropriate", "harassment", "copyright", "other"];

function getLangParam(req) {
  return req.query.lang === "sl" ? "sl" : "en";
}

// CORS + no-cache for the whole API, ahead of every route below.
router.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Device-Id");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------- reads ---

router.get("/feed", (req, res) => {
  const lang = getLangParam(req);
  const copy = i18n[lang];
  const origin = getOrigin(req);

  const latest = statements.latestUpload.get();
  const posts = statements.newestUploads.all(4).map((row) => serializePost(row, origin));
  const top = statements.topUploadsAllTime.all(3).map((row) => serializePost(row, origin));
  const dailyRow = getDailyUpload();

  res.json({
    stats: {
      visits: getTotalVisits(),
      uploads: statements.totalUploads.get().count,
      days_since_last: daysSince(latest?.created_at)
    },
    quote: (() => { const q = ai.getQuotes(lang); return q[Math.floor(Math.random() * q.length)]; })(),
    daily: dailyRow ? serializePost(dailyRow, origin) : null,
    posts,
    top
  });
});

router.get("/posts", (req, res) => {
  const origin = getOrigin(req);

  let perPage = Number.parseInt(req.query.per_page, 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 24;
  perPage = Math.min(perPage, 50);

  let page = Number.parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  const offset = (page - 1) * perPage;

  const sort = ["newest", "top", "featured", "pinned"].includes(req.query.sort) ? req.query.sort : "newest";
  const statement = {
    newest: statements.pagedUploadsNewestApi,
    top: statements.pagedUploadsTop,
    featured: statements.pagedUploadsFeatured,
    pinned: statements.pagedUploadsPinned
  }[sort];

  const rows = statement.all(perPage + 1, offset);
  const hasNext = rows.length > perPage;
  const items = rows.slice(0, perPage).map((row) => serializePost(row, origin));

  res.json({ items, page, per_page: perPage, has_next: hasNext });
});

router.get("/posts/:id", (req, res) => {
  const post = statements.uploadByIdPublic.get(Number(req.params.id));
  if (!post) return res.status(404).json({ error: "Post not found." });
  res.json(serializePost(post, getOrigin(req)));
});

router.get("/random-phrase", (req, res) => {
  const phrases = ai.getPhrases(getLangParam(req));
  res.json({ phrase: phrases[Math.floor(Math.random() * phrases.length)] });
});

// --------------------------------------------------------------- upload ---

const uploadRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyFn: (req) => getClientIp(req),
  message: "Too many uploads from this address. Try again in a few minutes."
});

router.post("/posts", uploadRateLimit, upload.single("image"), (req, res) => {
  const copy = i18n[getLangParam(req)];
  const title = String(req.body.title || "").trim();
  const description = String(req.body.description || "").trim();

  if (!title || (!description && !req.file)) {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    return res.status(400).json({ error: copy.notEnoughBody });
  }

  const result = statements.insertUpload.run(
    title.slice(0, 120),
    description.slice(0, 1200),
    req.file ? req.file.filename : null,
    req.file ? req.file.originalname : null,
    req.file ? kindForMime(req.file.mimetype) : "story"
  );
  const created = statements.uploadByIdAny.get(result.lastInsertRowid);
  res.status(201).json(serializePost(created, getOrigin(req)));
});

// ---------------------------------------------------------------- votes ---

const voteRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyFn: (req) => getClientIp(req),
  message: "Too many votes from this address. Slow down."
});

router.post("/posts/:id/vote", voteRateLimit, (req, res) => {
  const postId = Number(req.params.id);
  const post = statements.uploadByIdPublic.get(postId);
  if (!post) return res.status(404).json({ error: "Post not found." });

  const deviceId = req.headers["x-device-id"];
  if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
    return res.status(400).json({ error: "Missing or invalid X-Device-Id header." });
  }

  const value = req.body?.value;
  if (value !== 1 && value !== -1 && value !== 0) {
    return res.status(400).json({ error: "value must be 1, -1, or 0." });
  }

  castVote(postId, deviceId, value);
  const updated = statements.uploadByIdPublic.get(postId);
  res.json(serializePost(updated, getOrigin(req)));
});

// --------------------------------------------------------------- report ---

// Required by Google Play's User Generated Content policy and Apple's
// Guideline 1.2: apps with UGC need an in-app way to flag objectionable
// content. Unlike votes, no X-Device-Id is required - multiple reports
// from the same device are a legitimate stronger signal, not abuse; the
// per-IP rate limit below is what stops actual flooding.
const reportRateLimit = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyFn: (req) => getClientIp(req),
  message: "Too many reports from this address. Try again later."
});

router.post("/posts/:id/report", reportRateLimit, (req, res) => {
  const postId = Number(req.params.id);
  const post = statements.uploadByIdPublic.get(postId);
  if (!post) return res.status(404).json({ error: "Post not found." });

  const reason = req.body?.reason;
  if (!REPORT_REASONS.includes(reason)) {
    return res.status(400).json({ error: `reason must be one of: ${REPORT_REASONS.join(", ")}.` });
  }

  const details = typeof req.body?.details === "string" ? req.body.details.trim().slice(0, 500) : "";

  fileReport(postId, reason, details);
  res.status(201).json({ ok: true });

  // Fire-and-forget, after the response is already sent - a slow or
  // misconfigured mail server should never make the reporter wait.
  sendReportNotification({ post, reason, details }).catch(() => {});
});

// -------------------------------------------------------------- comments ---

const commentRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 15,
  keyFn: (req) => getClientIp(req),
  message: "Too many comments from this address. Give it a minute."
});

function serializeComment(row) {
  return {
    id: row.id,
    post_id: row.post_id,
    body: row.body,
    created_at: toIsoUtc(row.created_at),
    upvotes: row.upvotes || 0,
    downvotes: row.downvotes || 0
  };
}

router.get("/posts/:id/comments", (req, res) => {
  const postId = Number(req.params.id);
  if (!statements.uploadByIdPublic.get(postId)) {
    return res.status(404).json({ error: "Post not found." });
  }

  let perPage = Number.parseInt(req.query.per_page, 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 50;
  perPage = Math.min(perPage, 100);
  let page = Number.parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;

  const total = statements.countCommentsForPost.get(postId).count;
  const rows = statements.commentsForPost.all(postId, perPage + 1, (page - 1) * perPage);

  res.json({
    items: rows.slice(0, perPage).map(serializeComment),
    page,
    per_page: perPage,
    total,
    has_next: rows.length > perPage
  });
});

router.post("/posts/:id/comments", commentRateLimit, (req, res) => {
  const postId = Number(req.params.id);
  if (!statements.uploadByIdPublic.get(postId)) {
    return res.status(404).json({ error: "Post not found." });
  }

  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body) return res.status(400).json({ error: "Comment body is required." });
  if (body.length > 1000) return res.status(400).json({ error: "Comment is too long (max 1000 characters)." });

  // Optional: used only to let a client recognise its own comments. Not
  // identity, not auth - comments stay anonymous either way.
  const rawDevice = req.headers["x-device-id"];
  const deviceId = typeof rawDevice === "string" && DEVICE_ID_RE.test(rawDevice) ? rawDevice : null;

  const created = addComment(postId, body, deviceId);
  res.status(201).json(serializeComment(created));
});

router.post("/comments/:id/vote", voteRateLimit, (req, res) => {
  const commentId = Number(req.params.id);
  const comment = statements.commentById.get(commentId);
  if (!comment || comment.hidden) return res.status(404).json({ error: "Comment not found." });

  const deviceId = req.headers["x-device-id"];
  if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
    return res.status(400).json({ error: "Missing or invalid X-Device-Id header." });
  }

  const value = req.body?.value;
  if (value !== 1 && value !== -1 && value !== 0) {
    return res.status(400).json({ error: "value must be 1, -1, or 0." });
  }

  res.json(serializeComment(castCommentVote(commentId, deviceId, value)));
});

router.post("/comments/:id/report", reportRateLimit, (req, res) => {
  const commentId = Number(req.params.id);
  const comment = statements.commentById.get(commentId);
  if (!comment || comment.hidden) return res.status(404).json({ error: "Comment not found." });

  const reason = req.body?.reason;
  if (!REPORT_REASONS.includes(reason)) {
    return res.status(400).json({ error: `reason must be one of: ${REPORT_REASONS.join(", ")}.` });
  }
  const details = typeof req.body?.details === "string" ? req.body.details.trim().slice(0, 500) : "";

  // Counted against the parent post, so a thread full of reported
  // comments still surfaces in the admin's reported filter.
  fileReport(comment.post_id, reason, details, commentId);
  res.status(201).json({ ok: true });

  const post = statements.uploadByIdAny.get(comment.post_id);
  if (post) {
    sendReportNotification({
      post,
      reason,
      details: `[comment #${commentId}] ${comment.body.slice(0, 200)}${details ? ` - ${details}` : ""}`
    }).catch(() => {});
  }
});

// ------------------------------------------------------------ donations ---

router.post("/donations/stripe/session", async (req, res, next) => {
  try {
    const tierId = req.body?.tier_id;
    const url = await donations.createStripeCheckoutSession(tierId, getOrigin(req));
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

router.post("/donations/apple/verify", async (req, res, next) => {
  try {
    await donations.verifyAppleReceipt({ productId: req.body?.product_id, token: req.body?.token });
    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
});

router.post("/donations/google/verify", async (req, res, next) => {
  try {
    await donations.verifyGoogleReceipt({ productId: req.body?.product_id, token: req.body?.token });
    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
});

// Note: POST /api/v1/webhooks/stripe is mounted directly on the app, ahead
// of express.json(), because Stripe's signature check needs the raw body -
// see server.js.

// ---------------------------------------------------------- error tail ---

router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 400;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "Something went wrong." });
});

module.exports = router;
