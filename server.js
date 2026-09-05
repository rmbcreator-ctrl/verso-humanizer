'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { getConfig, updateConfig, resetConfig, DEFAULTS } = require('./config-store');
const historyStore = require('./history-store');
const { protect, restore, placeholderCounts, countsEqual, isPureProtected } = require('./protect');

const app = express();
const PORT = process.env.PORT || 4173;

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const SETTINGS_PASSWORD = 'Demo@9090';
const SESSION_COOKIE = 'verso_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

app.use(express.json({ limit: '500mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Settings auth — a single shared password gates read/write access to the
// prompts, models, and generation parameters below. Sessions are opaque
// tokens held server-side in memory (not JWTs, nothing to forge) and handed
// to the browser as an httpOnly cookie, so the password itself never touches
// client-side JS after login.
// ---------------------------------------------------------------------------
const sessions = new Map(); // token -> expiry timestamp
const loginAttempts = new Map(); // ip -> { count, lockedUntil }

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAuthenticated(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry || expiry < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Not authenticated.' });
}

app.post('/api/settings/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const attempt = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };

  if (attempt.lockedUntil > Date.now()) {
    const waitSec = Math.ceil((attempt.lockedUntil - Date.now()) / 1000);
    res.status(429).json({ error: `Too many attempts. Try again in ${waitSec}s.` });
    return;
  }

  const { password } = req.body || {};
  if (password !== SETTINGS_PASSWORD) {
    attempt.count += 1;
    if (attempt.count >= 5) {
      attempt.lockedUntil = Date.now() + 60 * 1000;
      attempt.count = 0;
    }
    loginAttempts.set(ip, attempt);
    res.status(401).json({ error: 'Incorrect password.' });
    return;
  }

  loginAttempts.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`
  );
  res.json({ ok: true });
});

app.post('/api/settings/logout', (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/settings/session', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

app.get('/api/settings', requireAuth, (req, res) => {
  res.json({ config: getConfig() });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const updated = updateConfig(req.body || {});
  res.json({ config: updated });
});

app.post('/api/settings/reset', requireAuth, (req, res) => {
  const reset = resetConfig();
  res.json({ config: reset });
});

app.get('/api/settings/defaults', requireAuth, (req, res) => {
  res.json({ config: DEFAULTS });
});

// ---------------------------------------------------------------------------
// History — every completed humanize run (full original + full humanized
// text, timestamped) is logged server-side. Read/delete access requires the
// same settings session as everything else on /settings.
// ---------------------------------------------------------------------------
app.get('/api/settings/history', requireAuth, (req, res) => {
  // No forced page-size cap — omit ?limit (or pass 0) to fetch everything.
  const limit = Number(req.query.limit) || 0;
  const offset = Number(req.query.offset) || 0;
  res.json(historyStore.list({ limit, offset }));
});

app.delete('/api/settings/history/:id', requireAuth, (req, res) => {
  const ok = historyStore.remove(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }
  res.json({ ok: true });
});

app.delete('/api/settings/history', requireAuth, (req, res) => {
  historyStore.clear();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Extract-then-draft pipeline (v3).
//
// v1 ("restrained editor") barely touched sentence structure — 100% AI on
// GPTZero. v2 ("aggressive restructure, 2 passes") changed structure a lot
// but was still an EDIT of the original sentences — still 100% AI on
// GPTZero, 100% on ZeroGPT. The common failure: both passes still read and
// transformed the AI-drafted sentences directly, so the model's continuation
// stayed anchored to the source's phrasing and — critically — to a "cover
// every point evenly, in order" structure, which is itself a strong AI tell.
//
// What actually worked in live testing (0% AI GPT / "Human written" on
// ZeroGPT): a two-stage pipeline where stage 2 NEVER sees the original
// sentences at all.
//   Stage A (extract): compress the passage into bare content — facts,
//     events, claims, dialogue, names, numbers — as loose notes, explicitly
//     not in the original's sentence structure.
//   Stage B (draft): write the passage for the first time from only those
//     notes, in a real, specific, unevenly-weighted authorial voice.
//   Stage C (guard): checked against the original, fixes only rule
//     violations (banned words, grand-finale endings, invented detail).
//
// Every prompt, model, and parameter here is a live default — the actual
// values used at request time come from config-store.js and are editable
// from the password-protected /settings page.
// ---------------------------------------------------------------------------

function getStyle(config, styleKey) {
  return config.styles[styleKey] || config.styles[config.defaultStyle] || config.styles.author;
}

// Merges a style's own tuned banned-phrase list with the user's personal
// additions (config.bannedPhrases) — never with another style's list, since
// a phrase banned for one register (e.g. "furthermore" for Author) can be
// normal, correct usage in another (Academic).
function bannedPhrasesFor(config, styleKey) {
  return [...getStyle(config, styleKey).bannedPhrases, ...(config.bannedPhrases || [])];
}

function buildDraftPrompt(config, intensity, styleKey) {
  const key = config.intensity[intensity] ? intensity : 'balanced';
  const style = getStyle(config, styleKey);
  return config.prompts.draft
    .replace('{{STYLE_INSTRUCTION}}', style.instruction)
    .replace('{{CONTRACTIONS_RULE}}', style.contractionsRule)
    .replace('{{PUNCTUATION_RULE}}', style.punctuationRule)
    .replace('{{INTENSITY_INSTRUCTION}}', config.intensity[key])
    .replace('{{BANNED_PHRASES}}', bannedPhrasesFor(config, styleKey).join(', '));
}

// Shared across every style that opts in via `symmetryRule: true` — the
// "not just X, it's Y" tell shows up regardless of register, so unlike
// endingRule/extraChecks (genuinely register-specific) this one rule text
// is fixed, not user-editable per style.
const SYMMETRY_GUARD_RULE =
  'No sentence should mechanically resolve a single tidy idea in a "not just X, it\'s Y" or perfectly symmetrical construction. If you find one, break the symmetry.';

function buildGuardPrompt(config, styleKey) {
  const style = getStyle(config, styleKey);
  const styleRules = [style.endingRule, style.symmetryRule ? SYMMETRY_GUARD_RULE : null, ...(style.extraChecks || [])]
    .filter(Boolean)
    .map((text, i) => `${i + 4}. ${text}`)
    .join('\n');
  return config.prompts.guard
    .replace('{{BANNED_PHRASES}}', bannedPhrasesFor(config, styleKey).join(', '))
    .replace('{{STYLE_RULES}}', styleRules);
}

async function postGenerateContent(apiKey, model, generationConfig, systemPrompt, userText) {
  const url = `${API_BASE}/${model}:generateContent?key=${apiKey}`;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig,
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// API key rotation — up to 5 keys, configured in Settings. `apiKeyCursor` is
// "the key we currently believe works": every callGemini() starts there, and
// only moves on when that key comes back rate-limited (HTTP 429), so calls
// stay sticky on one key instead of round-robining every request. Once it
// moves past a rate-limited key, it stays moved — every subsequent call
// (across every remaining chunk, and every extract/draft/guard stage within
// them) starts from the new position, so no further request wastes a round
// trip on a key already known to be capped. It's process-wide, in-memory
// (module-level, not per-request) and intentionally not persisted: a fresh
// process should retry from key #1 rather than remember yesterday's outage.
let apiKeyCursor = 0;

function getApiKeys(config) {
  // `config.apiKeys` is sanitized (trimmed, deduped-blank, capped at 5) by
  // config-store.js on every load and save, so this trusts it as-is.
  return config.apiKeys || [];
}

async function callGemini(config, model, systemPrompt, userText, generationOverrides) {
  const generationConfig = Object.assign(
    {
      temperature: 0.9,
      topP: 0.95,
      // No maxOutputTokens — leave it unset so the API falls back to each
      // model's own maximum instead of us imposing an artificial word cap.
      // No default thinkingConfig either: support for thinkingBudget: 0 is
      // inconsistent across models (gemini-3.1-flash-lite accepts it,
      // gemini-3.5-flash-lite 400s on it) and, since models are fully
      // user-configurable now, guessing wrong here means doubling every
      // request through the retry path below. Pass it explicitly via
      // generationOverrides for a specific call if a specific model is
      // known to support and benefit from it.
    },
    generationOverrides || {}
  );

  const keys = getApiKeys(config);
  if (!keys.length) throw new Error('No Gemini API key configured — add one in Settings.');

  let res;
  let usedKeyIndex = apiKeyCursor % keys.length;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    usedKeyIndex = (apiKeyCursor + attempt) % keys.length;
    const key = keys[usedKeyIndex];
    res = await postGenerateContent(key, model, generationConfig, systemPrompt, userText);

    // Defensive fallback, kept for whenever a caller does pass thinkingConfig
    // explicitly: silently retry once without it rather than hard-failing a
    // model-specific quirk. Same key — this isn't a rate-limit issue.
    if (res.status === 400 && generationConfig.thinkingConfig) {
      const errText = await res.text().catch(() => '');
      console.error(`[${model}] 400 with thinkingConfig set, retrying without it: ${errText.slice(0, 150)}`);
      const { thinkingConfig, ...withoutThinking } = generationConfig;
      res = await postGenerateContent(key, model, withoutThinking, systemPrompt, userText);
    }

    if (res.status !== 429) break;

    const isLastKey = attempt === keys.length - 1;
    console.error(
      `[${model}] API key #${usedKeyIndex + 1}/${keys.length} rate-limited (429)` +
        (isLastKey ? ' — all configured keys are rate-limited' : ' — rotating to the next key')
    );
  }
  // Land the cursor on whichever key we last tried: a success or a
  // non-429 error sticks there for next time; if every key came back
  // 429, this just wraps back to where we started, which is fine — the
  // next call will re-probe from key #1 and the model-tier fallback in
  // callWithChain takes over from here.
  apiKeyCursor = usedKeyIndex;

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini ${model} HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const candidate = data && data.candidates && data.candidates[0];
  const text =
    candidate &&
    candidate.content &&
    candidate.content.parts &&
    candidate.content.parts.map((p) => p.text || '').join('');

  if (!text) {
    const reason = candidate && candidate.finishReason;
    throw new Error(`Gemini ${model} returned no text (finishReason: ${reason || 'unknown'})`);
  }
  return text.trim();
}

// Model-agnostic fallback chains. These reference only tier NAMES
// (main/flash/lite) — the actual model IDs behind each name live in
// config.models and are fully user-editable from /settings. Swapping in a
// different provider or a next-gen model is a one-field settings change,
// never a code change.
const DRAFT_CHAIN = ['main', 'flash', 'lite'];
const EXTRACT_GUARD_CHAIN = ['lite', 'flash'];

async function callWithChain(config, tierChain, systemPrompt, userText, generationOverrides) {
  let lastErr;
  for (let i = 0; i < tierChain.length; i++) {
    const tier = tierChain[i];
    const model = config.models[tier];
    if (!model) continue;
    try {
      return await callGemini(config, model, systemPrompt, userText, generationOverrides);
    } catch (err) {
      lastErr = err;
      const next = tierChain[i + 1];
      console.error(
        `[${tier}:${model} failed] ${err.message}` +
          (next ? ` — trying ${next}:${config.models[next]}` : ' — no more tiers to try')
      );
    }
  }
  throw lastErr || new Error('No models configured for this stage.');
}

async function guardPass(config, original, rewritten, styleKey) {
  return await callWithChain(
    config,
    EXTRACT_GUARD_CHAIN,
    buildGuardPrompt(config, styleKey),
    `ORIGINAL:\n"""${original}"""\n\nREWRITE:\n"""${rewritten}"""`,
    { temperature: config.generation.guard.temperature }
  );
}

// ---------------------------------------------------------------------------
// Chunk-type dispatch.
//
// The 3-stage extract/draft/guard pipeline below is built to discard a
// passage's original structure and phrasing entirely and write it fresh —
// exactly right for flowing prose paragraphs, and exactly wrong for
// headings and lists, where structure IS the content. A user reported the
// original single-pipeline design was flattening numbered lists and
// headings into plain prose. Fix: classify each chunk by its Markdown
// block type (see classifyParagraph, below) and route it accordingly —
//   heading    -> passed through untouched, no LLM call. A heading is a
//                 structural label, not prose; there's nothing to humanize
//                 and real risk in rewriting it into a sentence.
//   list       -> a separate, lighter single-call prompt (config.prompts.list)
//                 that rewords each item's text while a deterministic
//                 marker-count check guarantees the same items, same order,
//                 same markers survive — never the full restructure-everything
//                 treatment, which would blow up terse list items.
//   blockquote -> '> ' stripped, run through the normal prose pipeline,
//                 then reattached line by line.
//   paragraph  -> the original 3-stage pipeline, unchanged.
// ---------------------------------------------------------------------------
// Generic garbling safety net, alongside the placeholder/marker checks
// below: an occasional model glitch (more common on the cheaper fallback
// tiers under load) can inject a stray token from an unrelated script into
// otherwise-English output — e.g. "it used来" instead of "it used to". No
// prompt reliably prevents this, so it's caught deterministically: if the
// original had no CJK/Hangul/Kana characters and the rewrite does, that's
// corruption, not a stylistic choice, and the chunk falls back unchanged.
const FOREIGN_SCRIPT_RE = /[一-鿿぀-ヿ가-힣]/;
function hasInjectedForeignScript(original, rewritten) {
  return FOREIGN_SCRIPT_RE.test(rewritten) && !FOREIGN_SCRIPT_RE.test(original);
}

// A heading counts as "sentence-style" — worth humanizing — if it's long
// enough to actually read as a written claim rather than a label, or if it
// ends the way a sentence does. Word-count threshold is deliberately a bit
// generous (short labels rarely cross 8 words; "Third Quarter Marketing
// Results" is 4) so ordinary section titles stay untouched by default.
function isSentenceHeading(headingBody) {
  const words = headingBody.split(/\s+/).filter(Boolean);
  const endsLikeSentence = /[.!?]$/.test(headingBody);
  return words.length > 8 || endsLikeSentence;
}

async function humanizeHeadingChunk(config, hashes, headingBody, fullOriginal) {
  const expectedPlaceholders = placeholderCounts(headingBody);

  let rewritten;
  try {
    rewritten = await callWithChain(config, DRAFT_CHAIN, config.prompts.heading, headingBody, {
      temperature: config.generation.heading.temperature,
    });
  } catch {
    return { text: fullOriginal, protectedPassthrough: true };
  }

  // Deterministic safety net: a heading rewrite must stay a single line, a
  // real line of text, and every protected placeholder must still be
  // present exactly once. Any violation falls back to the original
  // heading unchanged rather than risking a broken or corrupted title.
  const singleLine = rewritten.split('\n')[0].trim().replace(/^#+\s*/, '');
  const isSingleLine = !rewritten.trim().includes('\n');
  if (
    !singleLine ||
    !isSingleLine ||
    !countsEqual(placeholderCounts(singleLine), expectedPlaceholders) ||
    hasInjectedForeignScript(headingBody, singleLine)
  ) {
    return { text: fullOriginal, protectedPassthrough: true };
  }

  return { text: `${hashes} ${singleLine}`, protectedPassthrough: false };
}

async function humanizeChunk(config, text, intensity, precedingContext, chunkType, styleKey) {
  // A chunk that's nothing but protected placeholders (e.g. a standalone
  // table) never needs to touch the LLM: zero prose to humanize, zero risk,
  // zero API cost.
  if (isPureProtected(text)) {
    return { text, protectedPassthrough: false, skippedProtected: true };
  }

  if (chunkType === 'heading') {
    const match = text.match(/^(#{1,6})[ \t]+([\s\S]*)$/);
    const hashes = match ? match[1] : '#';
    const headingBody = match ? match[2].trim() : text;
    // Short labels ("Introduction," "Q3 Results," "Next Steps") are
    // structural markers, not prose — passed through untouched. A long,
    // sentence-style heading ("This report demonstrates significant
    // improvements across all key metrics") is really a sentence wearing a
    // #, and reads exactly as AI-flavored as any other flat, template-shaped
    // sentence — so it gets humanized too.
    if (!isSentenceHeading(headingBody)) {
      return { text, protectedPassthrough: false, skippedHeading: true };
    }
    return await humanizeHeadingChunk(config, hashes, headingBody, text);
  }

  if (chunkType === 'list') {
    return await humanizeListChunk(config, text);
  }

  if (chunkType === 'blockquote') {
    const lines = text.split('\n');
    if (lines.every((l) => /^>\s?/.test(l) || l.trim() === '')) {
      const stripped = lines.map((l) => l.replace(/^>\s?/, '')).join('\n');
      const result = await humanizeProseChunk(config, stripped, intensity, precedingContext, styleKey);
      const requoted = result.text
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
      return { ...result, text: requoted };
    }
    // Not uniformly quoted (mixed content) — fall through to normal prose.
  }

  return await humanizeProseChunk(config, text, intensity, precedingContext, styleKey);
}

async function humanizeListChunk(config, text) {
  const expectedPlaceholders = placeholderCounts(text);
  const markerRe = /^\s*(?:[-*+]|\d+[.)])\s+/gm;
  const expectedMarkers = (text.match(markerRe) || []).length;

  let rewritten;
  try {
    // One call, not three — list items are short enough that the quality
    // gain from the full chain matters more than the quota cost.
    rewritten = await callWithChain(config, DRAFT_CHAIN, config.prompts.list, text, {
      temperature: config.generation.list.temperature,
    });
  } catch {
    return { text, protectedPassthrough: true };
  }

  const actualMarkers = (rewritten.match(markerRe) || []).length;

  // Deterministic safety net, same principle as the placeholder count check
  // below: if the item count/markers or any protected token drifted, the
  // rewrite is discarded in favor of the original list unchanged rather
  // than risking a corrupted structure reaching the author.
  if (
    actualMarkers !== expectedMarkers ||
    !countsEqual(placeholderCounts(rewritten), expectedPlaceholders) ||
    hasInjectedForeignScript(text, rewritten)
  ) {
    return { text, protectedPassthrough: true };
  }

  return { text: rewritten, protectedPassthrough: false };
}

// Returns { text, protectedPassthrough, skippedProtected }. `text` is
// always safe to use — either the humanized rewrite, or (if the chunk was
// pure protected content, or the protection integrity check below failed)
// the original chunk unchanged.
async function humanizeProseChunk(config, text, intensity, precedingContext, styleKey) {
  if (isPureProtected(text)) {
    return { text, protectedPassthrough: false, skippedProtected: true };
  }

  const expectedPlaceholders = placeholderCounts(text);

  // Stage A: compress into content-only notes, deliberately discarding the
  // original's sentence structure so stage B can never anchor to it. A
  // mechanical task — the cheaper, higher-quota tiers handle it fine.
  const notes = await callWithChain(
    config,
    EXTRACT_GUARD_CHAIN,
    config.prompts.extract,
    `PASSAGE:\n"""${text}"""`,
    { temperature: config.generation.extract.temperature }
  );

  // Stage B: draft fresh prose from only those notes, in a real authorial
  // voice, at higher temperature for genuine sentence-length variance. This
  // is the stage that actually determines detector evasion — it gets the
  // best tier first, degrading gracefully through flash then lite as quota
  // runs out.
  const draftSystem = buildDraftPrompt(config, intensity, styleKey);
  const draftUser = precedingContext
    ? `PRECEDING CONTEXT (already written — for voice/flow continuity only, do not repeat or reference it):\n"""${precedingContext}"""\n\nYOUR NOTES:\n"""${notes}"""`
    : `YOUR NOTES:\n"""${notes}"""`;

  const draft = await callWithChain(config, DRAFT_CHAIN, draftSystem, draftUser, {
    temperature: config.generation.draft.temperature,
    topP: config.generation.draft.topP,
  });

  // Stage C: enforce the banned-word / no-grand-finale / no-invented-detail
  // rules directly, checked against the original. Mechanical — cheap tiers.
  const guarded = await guardPass(config, text, draft, styleKey);

  // Deterministic safety net, independent of prompt compliance: if any
  // protected placeholder (formula or table) went missing, got duplicated,
  // or was altered anywhere across all three stages, the whole rewrite for
  // this chunk is discarded in favor of the original text unchanged. The
  // prompts (above, and in config-store.js) are the first line of defense;
  // this count check is the one that's actually load-bearing.
  if (!countsEqual(placeholderCounts(guarded), expectedPlaceholders) || hasInjectedForeignScript(text, guarded)) {
    return { text, protectedPassthrough: true };
  }

  return { text: guarded, protectedPassthrough: false };
}

// ---------------------------------------------------------------------------
// Chunking: split on paragraph boundaries, then greedily pack paragraphs into
// chunks under maxChunkChars without ever splitting a paragraph. Each
// element also records the separator that followed it in the original text
// so the output can be reassembled with identical spacing.
// ---------------------------------------------------------------------------
function splitParagraphs(text) {
  const parts = text.split(/(\n{2,})/);
  const paragraphs = [];
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i];
    const sep = parts[i + 1] || '';
    if (body.length === 0 && sep.length === 0) continue;
    paragraphs.push({ body, sep });
  }
  return paragraphs;
}

// Classifies a paragraph's Markdown block type so the pipeline can route
// it correctly (see the chunk-type dispatch comment above humanizeChunk).
// splitParagraphs already isolates most of these naturally — a heading, or
// a tight list with no blank lines between items, arrives as its own
// single paragraph as long as it's blank-line-separated from its
// neighbors, which is how clean Markdown (and Turndown's HTML->Markdown
// output) is structured.
function classifyParagraph(body) {
  const trimmed = body.trim();
  if (!trimmed) return 'paragraph';
  if (/^#{1,6}\s+/.test(trimmed)) return 'heading';
  if (/^>\s?/.test(trimmed)) return 'blockquote';
  if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(trimmed)) return 'list';
  return 'paragraph';
}

// Packs paragraphs into chunks under maxChunkChars, but — critically —
// never merges a heading or list into a chunk with anything else. Each
// heading and each list gets its own chunk, however short, so it can be
// routed to its own handling (passthrough / dedicated list prompt) instead
// of being folded into a "rewrite this as flowing prose" chunk alongside
// unrelated paragraphs, which is what was destroying document structure.
// Only consecutive plain prose paragraphs (and blockquotes) get packed
// together for chunking efficiency, exactly as before.
function packChunks(paragraphs, maxChunkChars) {
  const chunks = [];
  let current = null;

  function flush() {
    if (current && current.paragraphs.length) chunks.push(current);
    current = null;
  }

  for (const para of paragraphs) {
    const type = classifyParagraph(para.body);
    const len = para.body.length + para.sep.length;
    const mergeable = type === 'paragraph' || type === 'blockquote';

    if (!mergeable) {
      flush();
      chunks.push({ type, paragraphs: [para] });
      continue;
    }

    if (!current || current.type !== type || current.len + len > maxChunkChars) {
      flush();
      current = { type, paragraphs: [], len: 0 };
    }
    current.paragraphs.push(para);
    current.len += len;
  }
  flush();
  return chunks;
}

function chunkPlainText(paras) {
  return paras.map((p) => p.body + p.sep).join('');
}

app.post('/api/humanize', async (req, res) => {
  const { text, intensity } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'No text provided.' });
    return;
  }

  const config = getConfig();
  const styleKey = config.styles[req.body && req.body.style] ? req.body.style : config.defaultStyle;

  // Swap every formula/table/code block out for an opaque placeholder
  // before any of this text reaches an LLM. Chunking, and the pipeline
  // itself, only ever see the placeholder form; the real content is
  // restored just before anything is shown to the user or logged.
  const { protectedText, map } = protect(text);
  const paragraphs = splitParagraphs(protectedText);
  const chunks = packChunks(paragraphs, config.chunking.maxChunkChars);
  const total = chunks.length;

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });

  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  send({ type: 'start', total });

  let fullOutputProtected = '';
  let lastOutputTail = ''; // stays in placeholder form for LLM context
  let hadError = false;

  for (let i = 0; i < chunks.length; i++) {
    const plain = chunkPlainText(chunks[i].paragraphs);
    const inputText = plain.trimEnd();
    const trailingSep = plain.slice(inputText.length);

    try {
      const result = await humanizeChunk(config, inputText, intensity, lastOutputTail, chunks[i].type, styleKey);
      const rewritten = result.text;
      fullOutputProtected += rewritten + trailingSep;
      lastOutputTail = rewritten.slice(-220);

      send({
        type: 'progress',
        index: i + 1,
        total,
        original: restore(inputText, map),
        rewritten: restore(rewritten, map),
        // Headings are routinely left unchanged by design — that's not
        // noteworthy and doesn't need a banner. Tables/formulas/lists that
        // triggered protection are worth surfacing.
        protectedNote: result.skippedProtected
          ? 'Table or formula — left as-is.'
          : result.protectedPassthrough
            ? 'Kept this passage unchanged — a safety check after rewriting couldn’t confirm it was safe to use.'
            : undefined,
      });
    } catch (err) {
      hadError = true;
      const restoredOriginal = restore(inputText, map);
      send({
        type: 'progress',
        index: i + 1,
        total,
        original: restoredOriginal,
        rewritten: restoredOriginal,
        error: String(err.message || err),
      });
      fullOutputProtected += inputText + trailingSep;
      lastOutputTail = inputText.slice(-220);
    }
  }

  const fullOutput = restore(fullOutputProtected, map);

  try {
    historyStore.append({ intensity, style: styleKey, original: text, humanized: fullOutput, hadError });
  } catch (err) {
    console.error(`[history] failed to log run: ${err.message}`);
  }

  send({ type: 'done', text: fullOutput });
  res.end();
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, models: getConfig().models });
});

app.listen(PORT, () => {
  console.log(`Verso is running at http://localhost:${PORT}`);
});
