const crypto = require("crypto");

const i18n = require("./i18n");
const { statements } = require("./db");

function getLang(req) {
  const queryLang = req.query?.lang;
  if (queryLang === "sl" || queryLang === "en") return queryLang;
  return req.session?.lang === "sl" ? "sl" : "en";
}

function getCopy(req) {
  return i18n[getLang(req)];
}

function withLang(req, url) {
  const lang = getLang(req);
  return `${url}${url.includes("?") ? "&" : "?"}lang=${lang}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function daysSince(value) {
  if (!value) return null;
  const then = new Date(`${value}Z`);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86400000));
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(`${value}Z`));
}

/** SQLite stores CURRENT_TIMESTAMP as "YYYY-MM-DD HH:MM:SS" UTC with no
 * offset marker; append Z before handing it to Date so it isn't
 * misinterpreted as local time. */
function toIsoUtc(value) {
  if (!value) return null;
  const date = new Date(`${value}Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function getTotalVisits() {
  return statements.totalVisits.get().value;
}

/** Today's award. Prefers the AI's pick when there is a fresh one for
 * today, otherwise the original deterministic date-hash choice - which is
 * also what runs whenever Ollama is off, hasn't caught up yet, or picked a
 * post that has since been hidden or deleted. Required lazily so lib/ai.js
 * can keep depending on this module without a cycle. */
function getDailyUpload() {
  const aiPick = require("./ai").getDailyAwardPost();
  if (aiPick) return aiPick;

  // COUNT + OFFSET rather than loading every visible row into memory to
  // pick one. This runs on every page render, so the old version read the
  // whole archive - fine at 30 posts, quadratically annoying at 5000.
  const total = statements.countVisible.get().count;
  if (!total) return null;
  const stamp = new Date().toISOString().slice(0, 10);
  const hash = crypto.createHash("sha1").update(stamp).digest();
  // Two bytes, so the spread doesn't collapse once the archive passes 256.
  const index = ((hash[0] << 8) | hash[1]) % total;
  return statements.dailyPick.get(index) || null;
}

/** Origin the app/browser should use to build absolute URLs (image_url,
 * og:image). TLS is terminated upstream (HAProxy), so Node only ever sees
 * plain HTTP - trust the proxy's forwarded proto rather than req.protocol,
 * which would otherwise report http and produce broken https:// URLs. */
function getOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers.host || "sejbosejbo.fyi";
  return `${proto}://${host}`;
}

module.exports = {
  getLang,
  getCopy,
  withLang,
  escapeHtml,
  daysSince,
  formatDate,
  toIsoUtc,
  getTotalVisits,
  getDailyUpload,
  getOrigin
};
