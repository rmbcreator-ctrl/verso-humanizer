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
  // Up to 5 Gemini API keys, tried in order. server.js rotates to the next
  // one automatically whenever the current key comes back rate-limited
  // (HTTP 429), so a single free-tier key's RPM/RPD cap doesn't stall the
  // pipeline once more keys are on file — see apiKeyCursor in server.js.
  // GEMINI_API_KEY (.env locally, or however the host platform injects
  // secrets) seeds the first slot so a bare .env keeps working with zero
  // settings-page setup. No literal fallback — never hardcode a key in
  // source that may end up in a public repo.
  apiKeys: [process.env.GEMINI_API_KEY || ''].filter(Boolean),
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
{{STYLE_INSTRUCTION}}

The notes may contain placeholder tokens that look like ⟦P3⟧ or ⟦P8⟧. Each one is a formula or table the reader will see in its place later, and it is the one thing in this draft you have no liberty with. Every token in the notes must land in your draft exactly once, character for character, brackets and number intact. Put it wherever it falls naturally in your new sentences; it can move to a different clause or a different sentence than the notes suggest, since you are restructuring anyway, and a token that stood alone as its own paragraph should stay alone as its own paragraph. Do not split a token, fold two into one, rewrite the number, add words explaining what it "represents," or swap in a description of the thing it stands for. If a sentence around a token feels weak enough to cut, keep the token and cut around it. Missing or duplicated tokens are the one failure that gets the whole draft thrown out, so it beats every other instruction here.

Rules for both modes:
- {{CONTRACTIONS_RULE}}
- Sentence length must swing — never three sentences in a row of similar length.
- {{PUNCTUATION_RULE}}
- Never invent facts, names, numbers, quotes, or events not in the notes. Never drop ones that are there.
- Match the vocabulary register the notes imply — never flatten or dumb it down, never pad it with fancier synonyms either.
- If a note is marked EMPHASIZED, put real markdown emphasis (**bold** for strong emphasis, _italic_ for a lighter stress) on the corresponding words in your rewrite — not necessarily the same words as the original, just wherever that emphasis naturally lands in your new sentence. Don't add emphasis anywhere the notes don't call for it.
- Never use these words/phrases — every one is a well-documented AI tell: {{BANNED_PHRASES}}

{{INTENSITY_INSTRUCTION}}

Output only the finished passage. No preamble, no title, no notes, no markdown.`,

    guard: `You check a REWRITE against its ORIGINAL and a short list of rules, and fix ONLY what violates them. Everything else stays exactly as written — do not rephrase, restructure, or "improve" anything that isn't a violation.

Rules:
1. None of these words/phrases may appear in the rewrite, in any form: {{BANNED_PHRASES}}. If one appears, rewrite just that clause using a plainer, more specific alternative — do not touch the rest of the sentence.
2. Compare against the ORIGINAL: the rewrite must not contain any invented fact, sensory detail, gesture, physical description, emotional beat, or event that has no basis in the original — even a small plausible-sounding one. If you find an invented detail, cut it (or the clause containing it) rather than trying to preserve it.
3. Placeholder tokens like ⟦P3⟧ or ⟦P8⟧ stand in for formulas and tables that must reach the author unchanged. Collect every token in the ORIGINAL and check that each appears in the REWRITE exactly once, with the same characters and the same number. A token that is missing, appears twice, has a changed number, or has been replaced by words describing it is a violation. Fix it the narrow way: put the exact token back at the most sensible point in the sentence where its idea lives, or remove the extra copy, and leave the rest of that sentence and the passage as they are. Do not rewrite the passage or the paragraph to make room for the token. Never add a token that was not in the ORIGINAL.
{{STYLE_RULES}}

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

  // ---------------------------------------------------------------------
  // Writing styles — each selects the expository voice the draft stage
  // writes in, plus a register-tuned banned-phrase list and guard rules.
  // A blog voice's AI-tells are not an academic paper's tells (e.g.
  // "furthermore" is a normal academic connective, not a tell there;
  // ending on a stated conclusion is genre-correct in academic/legal
  // writing, not a tell), so each style carries its own answers rather
  // than reusing Author's. Drafted with Fable (2026-09) specifically to
  // target the gap between real professional registers and how an LLM
  // fakes them, not just "sound academic/legal/etc."
  //
  //   instruction      — the paragraph that fires in the draft prompt's
  //                       IF EXPOSITORY branch (narrative/fiction stays
  //                       style-agnostic; dialogue fidelity rules don't
  //                       vary by register).
  //   bannedPhrases    — register-specific AI tells, merged with the
  //                       user's own additions in top-level bannedPhrases
  //                       below (never the OTHER styles' lists — "robust"
  //                       is a tell in Author/Business but not evidence
  //                       of anything in Legal drafting, so lists don't
  //                       cross-contaminate).
  //   endingRule       — guard-stage check on how the passage may end.
  //                      Every style gets one; only Author's and
  //                      Journalism's actually forbid a stated conclusion
  //                      outright — the others scope what a conclusion is
  //                      allowed to say rather than banning it.
  //   symmetryRule     — whether to also guard against the mechanical
  //                      "not just X, it's Y" / perfectly symmetrical
  //                      construction. True for all five; it's a tell
  //                      everywhere, not just casual prose.
  //   extraChecks      — additional register-specific structural rules.
  //   contractionsRule / punctuationRule — draft-stage prose mechanics;
  //                      these vary by register far more than casual
  //                      writing advice usually assumes (no contractions
  //                      in Legal/Academic, more semicolons in Academic,
  //                      more em dashes in Journalism, fewer in Legal).
  // ---------------------------------------------------------------------
  styles: {
    academic: {
      label: 'Academic Research Paper',
      instruction: `Write as a researcher reporting findings to peers, not as a survey of a topic. Match the confidence of each claim to its evidence: state what the data supports flatly, and hedge only where a real limitation exists, naming it ("in samples under 200," "absent longitudinal data") rather than softening every sentence with "may" or "could." Let paragraphs take different shapes; not every one needs a topic sentence followed by three evenly weighted supports. Use precise field terms without glossing them for a lay reader, keep citations, figures, and numbers exactly where the notes place them, and use the first person plural if the notes do. Standard connectives (however, furthermore, thus, in contrast) are normal here. Stating a conclusion or implication is expected, but scope it to what was actually shown; do not inflate it into significance for the field.`,
      bannedPhrases: [
        'delve', 'nuanced', 'multifaceted', 'intricate', 'interplay', 'shed light on', 'sheds light',
        'underscore', 'underscores', 'highlight the importance', 'highlights the need',
        'plays a crucial role', 'plays a critical role', 'plays a vital role', 'plays a key role',
        'pivotal', 'paradigm shift', 'pave the way', 'groundbreaking', 'profound implications',
        'far-reaching implications', 'has garnered', 'in recent years', 'in the realm of', 'landscape',
        'ever-evolving', 'holistic', 'bridge the gap', 'it is worth noting', 'it is worth mentioning',
        'it should be noted', 'crucially', 'necessitates', 'a testament to', "in today's",
        'cannot be overstated', 'of paramount importance', 'offers valuable insights', 'valuable insights',
        'comprehensive understanding', 'deeper understanding', 'not only', 'not just',
      ],
      endingRule: 'The closing sentence may state a conclusion, result, or implication scoped to the claim just made, but it must not escalate into significance for the field, a transformation, or a change in "our understanding of X." Also treat a stock closer like "further research is needed" or "future work should address this" as a violation if it is the passage\'s final sentence with nothing more specific attached.',
      symmetryRule: true,
      extraChecks: [
        'No more than two consecutive sentences may open with the same hedge word (e.g. "may," "might," "could," "suggests") — vary the hedge or drop it.',
      ],
      contractionsRule: 'Avoid contractions; write out full forms throughout.',
      punctuationRule: 'Semicolons are natural in this register — up to three in the passage are fine. Keep em dashes to at most one; prefer commas or parentheses for asides.',
    },

    author: {
      label: 'Author (personal voice)',
      instruction: `Write with a specific, opinionated voice — someone who has a genuine take, not a summary machine. Pick the ONE point from the notes that matters most and lead with it, concretely and specifically — not a generic topic sentence. Let the rest trail in unevenly; do not cover every point with equal weight in a tidy row. A stray aside or a mid-thought self-correction is fine on rare occasion if it genuinely fits — don't reach for it as a reflex. Do NOT end on a grand summarizing statement about significance, transformation, or "what this means" — that close is one of the biggest tells of AI writing. End small and concrete instead.`,
      bannedPhrases: [
        'furthermore', 'moreover', 'in addition', 'overall', 'it is important to note',
        'delve', 'tapestry', 'testament', 'landscape', 'realm', 'robust', 'seamless',
        'leverage', 'harness', 'unlock', 'foster', 'crucial', 'ever-evolving',
        "in today's world", 'in conclusion', 'boasts', 'underscores',
        'plays a vital role', 'game changer', 'cutting-edge', 'significant moment',
        'transform', 'reshape', 'streamline', 'not just',
        'at the end of the day', "here's the thing", "let's be honest", 'spoiler alert',
        'the truth is', 'in a nutshell', 'a deep dive', 'navigate', 'journey',
      ],
      endingRule: 'The rewrite must not end on a grand summarizing statement about significance, transformation, change, or "what this means" (e.g. "this marks a pivotal moment," "this changes everything," "an everyday revolution"). If the last sentence does this, replace just that closing sentence with something small and concrete, or cut it if the passage reads fine without it.',
      symmetryRule: true,
      extraChecks: [],
      contractionsRule: 'Contractions wherever natural.',
      punctuationRule: 'At most one em dash and one semicolon in the whole passage.',
    },

    legal: {
      label: 'Formal Legal',
      instruction: `Write as a practitioner who has already done the analysis and is reporting it: rule, application, conclusion, in that order, with no throat-clearing. Be terse. Use the defined terms exactly and consistently (the Agreement, the Buyer, Section 4.2) and never swap in a synonym for one. State conclusions directly ("The claim is likely time-barred"), and when hedging, tie the hedge to a specific condition or open fact, not a general caution. Name the authority when one applies. Vary sentence length the way real memoranda do: one long, carefully qualified sentence followed by a short flat one. Omit disclaimers, invitations to consult counsel, and generic warnings about complexity or the importance of compliance. Passive voice is acceptable where the actor is legally irrelevant.`,
      bannedPhrases: [
        'legal landscape', 'landscape', 'navigate', 'navigating the complexities', 'complexities',
        'it is crucial', 'it is essential', 'it is imperative', 'it is important to note',
        'it should be noted', 'ensure compliance', 'safeguard', 'robust', 'comprehensive', 'seamless',
        'paramount', 'in the realm of', 'delve', 'myriad', 'a plethora of', 'nuanced', 'multifaceted',
        'aforementioned', 'heretofore', 'hereinabove', 'hereinafter',
        'legal ramifications', 'potential legal implications', 'consult with an attorney',
        'consult legal counsel', 'seek legal advice', 'this is not legal advice', 'jurisdiction-specific',
        'varies by jurisdiction', 'it is advisable', 'generally speaking', 'ultimately', 'bolster',
        'proactive', 'best practices', 'stakeholders', 'mitigate risk', 'highlight', 'underscore',
        'pivotal', 'not just', 'not only',
      ],
      endingRule: 'The passage should end on the operative conclusion or holding that follows from the analysis already in the ORIGINAL. Flag an ending that generalizes about risk or importance instead of stating a conclusion — e.g. "It is essential to carefully consider these factors" or "Parties should proceed with caution" in place of an actual holding. If the ORIGINAL states a concrete next step, end there instead; if it does not, do not invent one — a fabricated next step, deadline, or party obligation is itself a violation of rule 2 above, which takes priority over this rule.',
      symmetryRule: true,
      extraChecks: [
        'A defined term, once introduced, must not be referred to by a different noun later in the passage — check for and fix any such drift.',
      ],
      contractionsRule: 'Contractions are prohibited; use full forms throughout.',
      punctuationRule: 'Em dashes are rare in legal drafting — cap at one, and zero is often better. Semicolons are normal inside an enumerated list; outside a list, cap at one.',
    },

    business: {
      label: 'Business / Corporate Memo',
      instruction: `Write as a manager who needs a decision, not as someone describing a situation. Lead with the bottom line: the decision, the ask, or the consequence, with the number, the date, and the owner attached. Everything after that supports the first line and can be uneven; drop points that do not change what the reader should do. Prefer concrete figures and named tradeoffs ("costs $40K more but ships six weeks earlier") over adjectives. Short sentences, an occasional fragment, and a one-sentence paragraph are all normal. No enthusiasm, no pleasantries, and no explanation of why the topic matters; the reader already knows. Close on the next action or the deadline, not on a statement of confidence or a call to work together.`,
      bannedPhrases: [
        'I hope this finds you well', 'I am writing to', 'I wanted to', 'just wanted to',
        'as we move forward', "in today's fast-paced", 'ever-changing', 'ever-evolving', 'synergy',
        'synergies', 'leverage', 'streamline', 'robust', 'seamless', 'empower', 'drive growth',
        'drive value', 'key takeaways', 'actionable insights', 'best-in-class', 'holistic', 'unlock',
        'foster', 'enhance', 'elevate', 'utilize', 'in order to', 'please do not hesitate',
        'feel free to reach out', 'thank you for your attention', 'touch base', 'circle back',
        'at the end of the day', 'win-win', 'low-hanging fruit', 'paradigm', 'game changer',
        'game-changer', 'cutting-edge', 'impactful', 'value-add', 'mission-critical', 'excited to',
        'thrilled to', 'delighted to', 'we are pleased to', 'exciting opportunity',
        'it is important to note', 'crucial', 'vital', 'journey', 'ecosystem', 'landscape', 'navigate',
        'transform', 'innovative', 'commitment to excellence', 'together we', 'not just', 'not only',
        'delve', 'testament',
      ],
      endingRule: 'If the ORIGINAL already states or implies a next step, owner, or date, the rewrite must end there, not soften it into a summary or morale statement. If the ORIGINAL contains no actionable next step at all, do not invent one to force this pattern — ending on the single most consequential fact, stated plainly, is correct instead. Inventing a deadline, owner, or action with no basis in the ORIGINAL is itself a violation of rule 2 above, which takes priority over this rule.',
      symmetryRule: true,
      extraChecks: [
        'The first sentence must contain at least one concrete anchor — a number, a date, a name, or a decision verb. A first sentence that only names the topic, with no anchor, is a violation.',
      ],
      contractionsRule: "Contractions are fine where natural, but don't force them — real memos vary by company voice.",
      punctuationRule: 'At most one em dash and one semicolon in the whole passage — real memos lean on short sentences and line breaks instead.',
    },

    journalistic: {
      label: 'Journalistic / News Feature',
      instruction: `Write as a feature reporter, not an explainer. Open on the most specific, telling detail in the notes: a person, a place, a number, an object, a moment. The point of the piece arrives a beat later, not in the first sentence. Attribute every claim to someone or something, using "said" or "according to" and nothing fancier. Keep paragraphs to one to three sentences, mix long sentences with abrupt short ones, and let a quotation stand on its own line. No editorializing adverbs, no unnamed "experts," no telling the reader how to feel. Preserve names, figures, ages, and quotations exactly as given. End on a quote, an image, or a forward-looking specific, never on a summary of what it all means.`,
      bannedPhrases: [
        'in a world where', 'serves as a reminder', 'a stark reminder', 'highlights the challenges',
        'sheds light on', 'underscores', 'a testament to', 'the story of', 'is one of',
        'amid growing concerns', 'experts say', 'many believe', 'some say', 'it remains to be seen',
        'only time will tell', 'one thing is clear', 'the road ahead', 'at a crossroads',
        'sparked debate', 'raises questions', 'ripple effects', 'landscape', 'navigate', 'resilience',
        'resilient', 'vibrant', 'bustling', 'nestled', 'tapestry', 'a beacon', 'profound', 'poignant',
        'harrowing', 'heartwarming', 'against the backdrop', 'paints a picture', 'speaks volumes',
        'a glimpse into', 'echoes', 'resonates', 'in the heart of', 'a sense of', 'not just', 'not only',
        'delve', 'testament', 'transform',
      ],
      endingRule: 'The passage must end on a quote, a concrete image, or a specific forward-looking fact drawn from the ORIGINAL — never on a moral, a summary, or a statement of what it all means. This is the single most important rule for this register, but never invent a quote, image, or forward-looking fact that has no basis in the ORIGINAL to satisfy it — a fabricated quote is a rule-2 violation and takes priority over this rule. If the ORIGINAL has none of these available, end on its single most concrete, specific detail instead.',
      symmetryRule: true,
      extraChecks: [
        'The first sentence must not be a thesis or topic statement — it must contain a proper noun, a number, or a sensory detail.',
        'Flag any paragraph longer than three sentences.',
      ],
      contractionsRule: 'Contractions are natural inside quotations and fine, if sparing, in narration — match AP-style practice.',
      punctuationRule: 'Em dashes are used more freely in features — up to two are fine. Semicolons are almost never used in news copy — cap at zero.',
    },
  },
  defaultStyle: 'academic',

  // User's own personal additions, on top of whichever style's own list is
  // active — empty by default so a style's tuned list is never diluted or
  // contradicted by another style's tells (e.g. "furthermore" is banned for
  // Author but required-normal for Academic; this list must not pick a side).
  bannedPhrases: [],
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

// Trims, drops blanks, and caps at 5 — the settings page renders exactly 5
// key inputs, and callGemini's rotation loop in server.js assumes the array
// it's handed is already this clean.
function sanitizeApiKeys(keys) {
  return (Array.isArray(keys) ? keys : []).map((k) => String(k || '').trim()).filter(Boolean).slice(0, 5);
}

let current = DEFAULTS;

function load() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      // Migrate the pre-multi-key single `apiKey` field: only when the
      // saved file predates `apiKeys` entirely, so it never clobbers a
      // multi-key setup someone already saved through the new settings UI.
      if (!raw.apiKeys && raw.apiKey) {
        raw.apiKeys = [raw.apiKey];
      }
      if (raw.apiKeys) raw.apiKeys = sanitizeApiKeys(raw.apiKeys);

      // Migrate pre-Phase-2 saves: the draft/guard prompts used to hardcode
      // the Author voice and a fixed banned-word/ending-rule set directly in
      // the template text. Phase 2 moved all of that out into per-style
      // config (see `styles` above) and left {{STYLE_INSTRUCTION}} /
      // {{STYLE_RULES}} placeholders in the template instead — a prompt
      // saved before this change has neither placeholder, so .replace()
      // would silently no-op and every style would produce identical
      // output. Reset just these two prompts to the new template; nothing
      // else in a saved config is touched.
      if (raw.prompts && typeof raw.prompts.draft === 'string' && !raw.prompts.draft.includes('{{STYLE_INSTRUCTION}}')) {
        raw.prompts.draft = DEFAULTS.prompts.draft;
      }
      if (raw.prompts && typeof raw.prompts.guard === 'string' && !raw.prompts.guard.includes('{{STYLE_RULES}}')) {
        raw.prompts.guard = DEFAULTS.prompts.guard;
      }
      // Migrate the pre-Phase-2 global `bannedPhrases` list: it used to be
      // the entire active list (tuned for the one hardcoded Author voice).
      // That exact list now lives in styles.author.bannedPhrases, and this
      // top-level field means something different post-migration — the
      // user's own additions layered on top of WHICHEVER style is active.
      // Left as-is, the stale Author-tuned list (e.g. banning "furthermore")
      // would wrongly contaminate every other style, including the new
      // default Academic, where that word is normal usage. Detected via a
      // marker phrase distinctive to the old default rather than exact
      // array equality, so it still catches a lightly-edited copy of it.
      if (Array.isArray(raw.bannedPhrases) && raw.bannedPhrases.includes('ever-evolving')) {
        raw.bannedPhrases = [];
      }

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
  if (partial && partial.apiKeys) partial = { ...partial, apiKeys: sanitizeApiKeys(partial.apiKeys) };
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
