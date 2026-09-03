'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'data', 'config.json');

// ---------------------------------------------------------------------------
// Default configuration — the same prompts/models/params Verso ships with.
// Everything here is editable at runtime from the /settings page; edits are
// persisted to data/config.json and merged over these defaults on load.
// ---------------------------------------------------------------------------
const DEFAULTS = {
  // Sourced from the GEMINI_API_KEY environment variable (.env locally, or
  // however the host platform injects secrets). No literal fallback — never
  // hardcode a key in source that may end up in a public repo.
  apiKey: process.env.GEMINI_API_KEY || '',
  // ---------------------------------------------------------------------
  // Models — three cost/quality tiers, model-agnostic. You name whatever
  // model IDs you want for each tier here; the pipeline only ever refers to
  // the tier names (main/flash/lite), never a literal model string, so
  // swapping providers or model generations later is a one-place edit.
  //
  //   main  — costliest, highest-quality, lowest quota. Used first for the
  //           stage that actually determines output quality (the draft).
  //   flash — mid-tier: better quota than main, better quality than lite.
  //           First fallback for draft; first choice for extract/guard.
  //   lite  — cheapest, highest quota. Last-resort fallback everywhere.
  //
  // Fallback chains (fixed in code, tiers you assign are what's plugged in):
  //   draft (the call that determines detector evasion): main -> flash -> lite
  //   extract / guard (mechanical, structure-preserving): lite -> flash
  //
  // Confirmed live on the AI Studio rate-limit dashboard (Sept 2026, free
  // tier): "Flash" models (2.5/3/3.5/3.6/3.7/3.8 Flash) are capped at
  // 5 RPM / 20 RPD. "Flash Lite" models get 15 RPM / 500 RPD — 25x the
  // daily quota. Live A/B testing on ZeroGPT (same input, same prompts, only
  // the model changed) found Flash Lite has meaningfully weaker instruction
  // -following on the draft stage — 80.6% AI detected vs. 29.4% with Flash
  // on the identical passage — so it must not be the only model in the
  // draft chain. gemini-flash-lite-latest is Google's alias that always
  // points at the newest Flash Lite release, so it won't go stale like
  // gemini-2.0-flash did.
  // ---------------------------------------------------------------------
  models: {
    // main defaults to a Pro-class model. On a free-tier key this tier
    // typically has a 0 free quota (Google reserves Pro for paid billing),
    // so every call to it fails immediately and the chain falls through to
    // flash — by design, not a bug. Once billing is enabled, main starts
    // actually getting used.
    main: 'gemini-3.1-pro-preview',
    flash: 'gemini-2.5-flash',
    lite: 'gemini-flash-lite-latest',
  },
  chunking: {
    maxChunkChars: 1400,
  },
  generation: {
    extract: { temperature: 0.4 },
    draft: { temperature: 1.25, topP: 0.98 },
    guard: { temperature: 0.3 },
    list: { temperature: 0.8 },
    heading: { temperature: 0.8 },
  },
  prompts: {
    extract: `You compress a passage into bare content notes for yourself. Read the passage and write down everything it actually contains: every claim, fact, event, action, name, number, and image. Nothing added, nothing dropped.

Write loose, informal notes — not polished prose. Do NOT reuse the passage's own sentences or phrasing; describe the content in your own compressed shorthand instead.

If the passage is narrative (characters, scene, action): note the sequence of events, who does or says what, and any concrete sensory/emotional detail that is explicitly stated — do not infer or add detail that isn't there. Any line of dialogue must be copied out EXACTLY in quotation marks, word for word — dialogue is never paraphrased at this stage.

If the passage is expository (an argument, explanation, or reflection): note the claims and the specific evidence or examples attached to each one.

If any word or phrase in the passage is bolded (**like this**) or italicized (_like this_), mark which underlying idea carried that emphasis in your notes (e.g. "EMPHASIZED: the deadline is firm") — you're allowed to break the shorthand-only style for just this, since it's structural information the next writer needs, not phrasing to preserve.

The passage may contain placeholder tokens that look like ⟦P7⟧ or ⟦P12⟧. Each one stands in for a formula or table that has been removed on purpose, and you cannot see what it holds. Copy every token into your notes exactly as written, in the spot where it sits in the flow of the ideas, the same way you would carry over a proper name. Do not describe it, guess at what it contains, paraphrase it, rename it, or leave it out because the note around it is thin. A token is not a sentence from the passage, so the rule about not reusing the passage's wording does not apply to it. If the passage is nothing but a token, the note is that token.

Output only the notes. No preamble, no markdown.`,

    draft: `You are the original author of this passage, writing it for the very first time, for real, from scratch — using only the notes below as your own private outline. There is no "original wording" to preserve; there isn't one. You are simply telling this, your way, right now.

First, decide from the notes: is this narrative (a scene, characters, action, dialogue) or expository (an argument, explanation, or reflection)? Write accordingly.

IF NARRATIVE:
Write it as a novelist with a real ear — a specific narrative voice, not neutral description. Vary sentence length and rhythm with intent: let tension tighten the sentences, let reflection loosen them. Reproduce every quoted line of dialogue from the notes VERBATIM, exactly as quoted — only the narration around it is yours to write fresh. Do not summarize or flatten a scene into exposition. Do not change character names, actions, or plot facts. Restructure and re-voice only what is already there — do NOT add new sensory details, gestures, internal thoughts, physical descriptions, or emotional beats that are not explicitly in the notes, even small plausible-sounding ones. If a detail isn't in the notes, it isn't in the rewrite.

IF EXPOSITORY:
Write with a specific, opinionated voice — someone who has a genuine take, not a summary machine. Pick the ONE point from the notes that matters most and lead with it, concretely and specifically — not a generic topic sentence. Let the rest trail in unevenly; do not cover every point with equal weight in a tidy row. A stray aside or a mid-thought correction ("Actually—") is fine if it fits. Do NOT end on a grand summarizing statement about significance, transformation, or "what this means" — that close is one of the biggest tells of AI writing. End small and concrete instead.

The notes may contain placeholder tokens that look like ⟦P3⟧ or ⟦P8⟧. Each one is a formula or table the reader will see in its place later, and it is the one thing in this draft you have no liberty with. Every token in the notes must land in your draft exactly once, character for character, brackets and number intact. Put it wherever it falls naturally in your new sentences; it can move to a different clause or a different sentence than the notes suggest, since you are restructuring anyway, and a token that stood alone as its own paragraph should stay alone as its own paragraph. Do not split a token, fold two into one, rewrite the number, add words explaining what it "represents," or swap in a description of the thing it stands for. If a sentence around a token feels weak enough to cut, keep the token and cut around it. Missing or duplicated tokens are the one failure that gets the whole draft thrown out, so it beats every other instruction here.

Rules for both modes:
- Contractions wherever natural.
- Sentence length must swing — never three sentences in a row of similar length.
- At most one em dash and one semicolon in the whole passage.
- Never invent facts, names, numbers, quotes, or events not in the notes. Never drop ones that are there.
- Match the vocabulary register the notes imply — never flatten or dumb it down, never pad it with fancier synonyms either.
- If a note is marked EMPHASIZED, put real markdown emphasis (**bold** for strong emphasis, _italic_ for a lighter stress) on the corresponding words in your rewrite — not necessarily the same words as the original, just wherever that emphasis naturally lands in your new sentence. Don't add emphasis anywhere the notes don't call for it.
- Never use these words/phrases — every one is a well-documented AI tell: {{BANNED_PHRASES}}

{{INTENSITY_INSTRUCTION}}

Output only the finished passage. No preamble, no title, no notes, no markdown.`,

    guard: `You check a REWRITE against its ORIGINAL and a short list of rules, and fix ONLY what violates them. Everything else stays exactly as written — do not rephrase, restructure, or "improve" anything that isn't a violation.

Rules:
1. None of these words/phrases may appear in the rewrite, in any form: {{BANNED_PHRASES}}. If one appears, rewrite just that clause using a plainer, more specific alternative — do not touch the rest of the sentence.
2. The rewrite must not end on a grand summarizing statement about significance, transformation, change, or "what this means" (e.g. "this marks a pivotal moment," "this changes everything," "an everyday revolution"). If the last sentence does this, replace just that closing sentence with something small and concrete, or cut it if the passage reads fine without it.
3. No sentence should mechanically resolve a single tidy idea in a "not just X, it's Y" or perfectly symmetrical construction. If you find one, break the symmetry.
4. Compare against the ORIGINAL: the rewrite must not contain any invented fact, sensory detail, gesture, physical description, emotional beat, or event that has no basis in the original — even a small plausible-sounding one. If you find an invented detail, cut it (or the clause containing it) rather than trying to preserve it.
5. Placeholder tokens like ⟦P3⟧ or ⟦P8⟧ stand in for formulas and tables that must reach the author unchanged. Collect every token in the ORIGINAL and check that each appears in the REWRITE exactly once, with the same characters and the same number. A token that is missing, appears twice, has a changed number, or has been replaced by words describing it is a violation. Fix it the narrow way: put the exact token back at the most sensible point in the sentence where its idea lives, or remove the extra copy, and leave the rest of that sentence and the passage as they are. Do not rewrite the passage or the paragraph to make room for the token. Never add a token that was not in the ORIGINAL.

If none of these apply, return the rewrite completely unchanged.

Output only the corrected rewrite. No preamble, no notes, no markdown.`,

    list: `You are rewriting a Markdown list so it reads like a person wrote it. You get one list block as a string. Return the same list block, item text reworded, and nothing else.

Structural rules. These are checked by code after you run, so treat them as absolute:
- Same number of items, same order. Never add an item, drop one, merge two, split one, or move one.
- Keep every marker exactly as given: "1." stays "1.", "3." stays "3.", "-" stays "-", "*" stays "*". Do not renumber, do not swap bullet styles.
- Keep every line's indentation exactly as given. A nested sub-item indented under item 2 stays indented under item 2.
- One output line per input line. Same line structure, same blank lines.
- Placeholder tokens like ⟦P4⟧ are removed formulas or tables. Copy them character-for-character, in the same spot, and never describe or rewrite them.

Now the text of each item. That is what you change, and only that:
- Cut the corporate filler. No leverage, streamline, unlock, synergies, drive engagement, optimize, empower, robust, seamless, or anything in that family. Say what the item means in ordinary words.
- Stop every item from following the same shape. If item 1 is "Verb + object + which does Y," item 2 should not be. Start one with a noun, make one a fragment, let one be a plain short sentence.
- Let lengths differ. Real lists have a four-word item next to a two-sentence one. Do not smooth them into matching rhythm.
- Keep it list-sized. A phrase, or one or two sentences at most. This is a light rewrite, not a paragraph. If an item wants to grow into three sentences of setup, cut it back.
- Say only what the item says. Do not invent numbers, names, causes, or examples that are not there. Do not lose any that are.
- Preserve the item's meaning and intent. A step stays a step, a recommendation stays a recommendation.

Output the rewritten list and nothing more. No preamble, no closing note, no explanation, no code fence around it. The first character of your reply is the first character of the first list line.`,

    heading: `You are rewriting one document heading — specifically a long, sentence-style heading (not a short label like "Introduction" or "Q3 Results," which never reach you) — so it reads like a person titled their own section instead of a template generating one.

You get the heading text on its own, already stripped of its # marks. Return just the reworded heading, one line, nothing else.

Rules:
- It stays a heading: one line, title-length. Don't split it into two sentences or expand it into a paragraph — trim it down if anything, never grow it.
- Cut the AI-cliché phrasing — "a comprehensive look at," "unlocking," "leveraging," "the ultimate guide to," "everything you need to know about," "key insights into" — and any generic throat-clearing before the actual claim.
- Keep the same claim and the same specifics the author wrote. This is a rewording, not a new heading — don't sharpen it into a different point or add spin that wasn't there.
- Match the tone already present — if it read as a plain, direct statement, keep it plain and direct; if it had a bit of personality, keep that.
- Placeholder tokens like ⟦P4⟧ (formulas or tables) must be preserved exactly, character-for-character, wherever they fall.
- Never invent facts, numbers, or names that aren't in the original. Never drop ones that are there.

Output only the reworded heading text. No #, no quotation marks, no preamble, no explanation.`,
  },
  intensity: {
    light: 'Intensity: LIGHT. Stay close to the notes’ own order and balance of ideas. Keep changes to voice and rhythm, not structure.',
    balanced: 'Intensity: BALANCED. Feel free to reorder and re-weight ideas from the notes where it makes the passage read better. Take real authorial liberty with structure.',
    thorough: 'Intensity: THOROUGH. Take full authorial liberty — reorder freely, compress the minor points hard, expand on whatever earns it. Write it exactly as if this were entirely your own idea, start to finish.',
  },
  bannedPhrases: [
    'furthermore', 'moreover', 'in addition', 'overall', 'it is important to note',
    'delve', 'tapestry', 'testament', 'landscape', 'realm', 'robust', 'seamless',
    'leverage', 'harness', 'unlock', 'foster', 'crucial', 'ever-evolving',
    "in today's world", 'in conclusion', 'boasts', 'underscores',
    'plays a vital role', 'game changer', 'cutting-edge', 'significant moment',
    'transform', 'reshape', 'streamline', 'not just', "it's",
  ],
};

function deepMerge(base, override) {
  if (Array.isArray(base)) return Array.isArray(override) ? override : base;
  if (typeof base === 'object' && base !== null) {
    const out = { ...base };
    if (override && typeof override === 'object') {
      for (const key of Object.keys(override)) {
        out[key] = key in base ? deepMerge(base[key], override[key]) : override[key];
      }
    }
    return out;
  }
  return override === undefined ? base : override;
}

let current = DEFAULTS;

function load() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      current = deepMerge(DEFAULTS, raw);
    } else {
      current = DEFAULTS;
    }
  } catch (err) {
    console.error(`[config] failed to load persisted config, using defaults: ${err.message}`);
    current = DEFAULTS;
  }
  return current;
}

function persist() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf8');
}

function getConfig() {
  return current;
}

function updateConfig(partial) {
  current = deepMerge(current, partial);
  persist();
  return current;
}

function resetConfig() {
  current = DEFAULTS;
  persist();
  return current;
}

load();

module.exports = { getConfig, updateConfig, resetConfig, DEFAULTS };
