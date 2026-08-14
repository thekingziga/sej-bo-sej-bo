const i18n = require("./i18n");
const { statements } = require("./db");

/** Ollama-backed copy generation.
 *
 * Design constraint that drives everything here: this runs on a Raspberry
 * Pi 4 doing CPU-only inference. A tiny model still takes seconds to tens
 * of seconds per generation, so nothing may ever call the model during an
 * HTTP request. Instead a timer regenerates content into the ai_content
 * table and pages read the cached rows, which is a plain SQLite lookup.
 *
 * Every read falls back to the hand-written arrays in lib/i18n.js, so the
 * site is fully functional with no Ollama at all - same "unset means the
 * feature is simply off" contract as donations and SMTP.
 */

const OLLAMA_HOST = process.env.OLLAMA_HOST || "";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:0.5b";
// Generous: a Pi 4 generating ~60 tokens on a 0.5b model can genuinely
// take a minute or two under load. Nothing is waiting on this.
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 180000);

const CONTENT_INTERVAL_MS = 3 * 60 * 60 * 1000; // quotes / examples / phrases
const AWARD_INTERVAL_MS = 60 * 60 * 1000;       // checked hourly, acts once a day

function isEnabled() {
  return Boolean(OLLAMA_HOST);
}

function describeConfig() {
  return { enabled: isEnabled(), host: OLLAMA_HOST || null, model: OLLAMA_MODEL };
}

async function callOllama(prompt, { json = true } = {}) {
  if (!isEnabled()) throw new Error("Ollama is not configured.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const response = await fetch(`${OLLAMA_HOST.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        ...(json ? { format: "json" } : {}),
        options: { temperature: 1.0, num_predict: 400 }
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const body = await response.json();
    return String(body.response || "");
  } finally {
    clearTimeout(timer);
  }
}

/** Small models wander outside the JSON they were asked for - a stray
 * sentence before the array, a trailing note after it. Pull out the first
 * balanced JSON value rather than trusting the whole response to parse. */
function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to bracket scanning
  }
  const start = trimmed.search(/[[{]/);
  if (start === -1) return null;
  const open = trimmed[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      inString = !inString;
    } else if (!inString) {
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

/** Anything the model returns is untrusted input that ends up on a public
 * page, so it gets the same treatment as a user upload: right shape, sane
 * length, no empties. Returns null (keep the fallback) rather than
 * publishing something malformed. */
function cleanStringList(value, { min, max, maxLength }) {
  // Asked for a bare JSON array, qwen2.5:0.5b actually returns
  // {"funny_strings": [...]} - it invents a wrapper key, and the key name
  // changes with the prompt. So: take the array if we got one, otherwise
  // take the first array-of-strings found among the object's values,
  // whatever it happens to be called.
  let list = null;
  if (Array.isArray(value)) {
    list = value;
  } else if (value && typeof value === "object") {
    list = Object.values(value).find(
      (candidate) => Array.isArray(candidate) && candidate.some((item) => typeof item === "string")
    ) || null;
  }
  if (!list) return null;

  const cleaned = list
    .filter((item) => typeof item === "string")
    .map((item) => item
      // The model likes appending social-media hashtags ("... #funny
      // #badvideo") which look wrong on the page. Strip any trailing run
      // of them, plus surrounding quotes it sometimes leaves behind.
      .replace(/(?:\s+#[\p{L}\p{N}_]+)+\s*$/gu, "")
      .replace(/^["'\s]+|["'\s]+$/g, "")
      .replace(/\s+/g, " ")
      .trim())
    .filter((item) => item.length > 0 && item.length <= maxLength);

  if (cleaned.length < min) return null;
  return cleaned.slice(0, max);
}

const LANG_NAME = { en: "English", sl: "Slovenian" };

function promptFor(kind, lang) {
  const language = LANG_NAME[lang] || "English";
  const flavour = `"Sejbosejbo" is a made-up word for something so stupid it becomes legendary. The tone is deadpan, absurd, internet-meme humour. Never explain the joke.`;

  if (kind === "quotes") {
    return `${flavour}
Write 7 very short reaction quotes in ${language}, the kind you'd caption a screenshot of something idiotic. Each under 60 characters.
Respond with only a JSON array of 7 strings.`;
  }
  if (kind === "phrases") {
    return `${flavour}
Write 10 very short punchy labels in ${language}, like achievement titles for doing something stupid. Each under 45 characters.
Respond with only a JSON array of 10 strings.`;
  }
  if (kind === "examples") {
    return `${flavour}
Write 3 one-sentence examples in ${language} of someone doing something absurdly stupid, each starting with "Someone" (or its ${language} equivalent). Mundane, specific, technology or everyday life. Each under 70 characters.
Respond with only a JSON array of 3 strings.`;
  }
  throw new Error(`Unknown content kind: ${kind}`);
}

// Minimums are deliberately below what the prompt asks for. A 0.5b model
// routinely returns fewer items than requested (asked 3, gave 2), and
// rejecting those would mean permanently falling back despite a working
// model. The box renders fine with fewer lines.
const SPECS = {
  quotes: { min: 3, max: 7, maxLength: 80 },
  phrases: { min: 4, max: 10, maxLength: 60 },
  examples: { min: 2, max: 3, maxLength: 90 }
};

async function generateList(kind, lang) {
  const spec = SPECS[kind];
  const raw = await callOllama(promptFor(kind, lang));
  const parsed = extractJson(raw);
  const cleaned = cleanStringList(parsed, spec);
  if (!cleaned) throw new Error(`${kind}/${lang}: model returned unusable output`);
  statements.setAiContent.run(kind, lang, JSON.stringify(cleaned));
  return cleaned;
}

/** Picks the day's award post. The model only ever chooses among ids we
 * hand it, and the choice is validated against the visible set before
 * being stored - a hallucinated id falls back to the deterministic
 * date-hash pick rather than 500ing or showing a hidden post. */
async function generateDailyAward() {
  const posts = statements.dailyPool.all();
  if (!posts.length) throw new Error("award: no posts to choose from");

  // Cap the candidate list - a tiny model's context is small and long
  // prompts on a Pi are slow. Newest 40 keeps it current and cheap.
  const candidates = posts.slice(-40);
  const listing = candidates.map((p) => `${p.id}: ${p.title}`).join("\n");

  const raw = await callOllama(`"Sejbosejbo" means something so stupid it becomes legendary.
Below is a numbered list of posts. Pick the ONE that is the most absurd, stupid, or funny.

${listing}

Respond with only JSON: {"id": <the number>}`);

  const parsed = extractJson(raw);
  const chosenId = Number(parsed?.id);
  const match = candidates.find((p) => p.id === chosenId);
  if (!match) throw new Error(`award: model picked ${parsed?.id}, not a valid candidate`);

  statements.setAiContent.run("daily_award", "", JSON.stringify({ id: match.id, date: today() }));
  return match;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ------------------------------------------------------------- readers ---

function readCachedList(kind, lang) {
  const row = statements.getAiContent.get(kind, lang);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

/** The four public accessors. Each takes the static i18n array as the
 * fallback, so callers never have to think about whether AI is on. */
function getQuotes(lang) {
  return readCachedList("quotes", lang) || i18n[lang].quotes;
}

function getPhrases(lang) {
  return readCachedList("phrases", lang) || i18n[lang].phrases;
}

/** The yellow box on the homepage: 3 generated lines plus the fixed
 * "Sejbosejbo." punchline, which is the bit that must not drift. */
function getExamples(lang) {
  const generated = readCachedList("examples", lang);
  if (!generated) return i18n[lang].examples;
  return [...generated.slice(0, 3), i18n[lang].examples[3]];
}

/** Today's award, if the AI picked one today and that post is still
 * visible. Returns null so the caller can use the existing deterministic
 * pick - which is what runs whenever AI is off, stale, or the post got
 * hidden or deleted since. */
function getDailyAwardPost() {
  const row = statements.getAiContent.get("daily_award", "");
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (parsed.date !== today()) return null;
    return statements.uploadByIdPublic.get(Number(parsed.id)) || null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------- self-test ---

/** Walks the three things that can independently be wrong - reachable,
 * model present, model actually generates - and reports which step failed
 * rather than a single unhelpful "it didn't work". */
async function testConnection() {
  if (!isEnabled()) {
    return { ok: false, step: "config", message: "OLLAMA_HOST is not set." };
  }

  const base = OLLAMA_HOST.replace(/\/$/, "");
  const started = Date.now();

  let tags;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`${base}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      return { ok: false, step: "reach", message: `${base} answered ${response.status}.` };
    }
    tags = await response.json();
  } catch (err) {
    return {
      ok: false,
      step: "reach",
      message: `Could not reach ${base} (${err.name === "AbortError" ? "timed out" : err.message}). ` +
        `From inside the container 127.0.0.1 is the container itself - use the Pi's LAN IP.`
    };
  }

  const models = (tags.models || []).map((m) => m.name);
  // Ollama reports "qwen2.5:0.5b"; tolerate a configured name without the tag.
  const hasModel = models.some((name) => name === OLLAMA_MODEL || name.split(":")[0] === OLLAMA_MODEL.split(":")[0]);
  if (!hasModel) {
    return {
      ok: false,
      step: "model",
      message: `Reachable, but "${OLLAMA_MODEL}" isn't installed. Available: ${models.join(", ") || "none"}. Run: ollama pull ${OLLAMA_MODEL}`
    };
  }

  try {
    const raw = await callOllama(
      'Reply with only this JSON and nothing else: {"ok":true}',
      { json: true }
    );
    const parsed = extractJson(raw);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (!parsed) {
      return {
        ok: false,
        step: "generate",
        message: `Model responded in ${seconds}s but the output wasn't usable JSON: ${raw.slice(0, 120)}`
      };
    }
    return {
      ok: true,
      step: "generate",
      message: `Working. ${OLLAMA_MODEL} responded in ${seconds}s.`,
      models
    };
  } catch (err) {
    return {
      ok: false,
      step: "generate",
      message: `Model is installed but generation failed: ${err.name === "AbortError" ? `timed out after ${OLLAMA_TIMEOUT_MS / 1000}s` : err.message}`
    };
  }
}

// ----------------------------------------------------------- scheduling ---

let running = false;

async function refreshContent({ force = false } = {}) {
  if (!isEnabled() || running) return { skipped: true };
  running = true;
  const results = [];
  try {
    for (const kind of ["quotes", "phrases", "examples"]) {
      for (const lang of ["en", "sl"]) {
        const existing = statements.getAiContent.get(kind, lang);
        const age = existing ? Date.now() - new Date(`${existing.updated_at}Z`).getTime() : Infinity;
        if (!force && age < CONTENT_INTERVAL_MS) continue;
        try {
          await generateList(kind, lang);
          results.push(`${kind}/${lang}: ok`);
        } catch (err) {
          // Logged, not thrown: one bad generation must not stop the rest
          // or kill the timer. The old cached value stays in place.
          console.error(`[ai] ${err.message}`);
          results.push(`${kind}/${lang}: failed`);
        }
      }
    }
  } finally {
    running = false;
  }
  return { results };
}

async function refreshAward({ force = false } = {}) {
  if (!isEnabled()) return { skipped: true };
  const row = statements.getAiContent.get("daily_award", "");
  if (!force && row) {
    try {
      if (JSON.parse(row.value).date === today()) return { skipped: true };
    } catch {
      // corrupt row - fall through and regenerate
    }
  }
  try {
    const post = await generateDailyAward();
    return { ok: true, id: post.id };
  } catch (err) {
    console.error(`[ai] ${err.message}`);
    return { ok: false, error: err.message };
  }
}

function start() {
  if (!isEnabled()) {
    console.log("[ai] OLLAMA_HOST not set - using the built-in phrase lists.");
    return;
  }
  console.log(`[ai] using ${OLLAMA_HOST} (model ${OLLAMA_MODEL})`);

  // Kick off shortly after boot rather than immediately, so a cold start
  // isn't competing with the app coming up.
  setTimeout(() => {
    refreshContent().catch((err) => console.error("[ai]", err.message));
    refreshAward().catch((err) => console.error("[ai]", err.message));
  }, 30000).unref();

  setInterval(() => {
    refreshContent().catch((err) => console.error("[ai]", err.message));
  }, CONTENT_INTERVAL_MS).unref();

  setInterval(() => {
    refreshAward().catch((err) => console.error("[ai]", err.message));
  }, AWARD_INTERVAL_MS).unref();
}

module.exports = {
  isEnabled,
  describeConfig,
  testConnection,
  getQuotes,
  getPhrases,
  getExamples,
  getDailyAwardPost,
  refreshContent,
  refreshAward,
  start
};
