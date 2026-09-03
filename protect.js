'use strict';

// ---------------------------------------------------------------------------
// Protects content the humanizer pipeline must never alter — math formulas,
// tables, and code — by swapping each one out for an opaque placeholder
// token before the text ever reaches an LLM, then swapping the originals
// back in once the pipeline is done.
//
// Placeholder shape: ⟦P<n>⟧, using U+27E6/U+27E7 (mathematical white square
// brackets) specifically because that pair essentially never appears in
// real prose, LaTeX, or Markdown — so there's no realistic collision risk
// with the author's own text.
//
// This is the belt; the prompts (see config-store.js) are the suspenders —
// they instruct the model to preserve tokens verbatim. server.js adds a
// third layer: a deterministic post-hoc count check per chunk that discards
// any rewrite where a placeholder went missing, duplicated, or was altered,
// falling back to the original text for that chunk. Formulas and table data
// are guaranteed unchanged by that hard check, not by prompt compliance
// alone.
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /⟦P(\d+)⟧/g;

function makePlaceholder(id) {
  return `⟦P${id}⟧`;
}

function protect(text) {
  const map = new Map();
  let counter = 0;

  // `kind` distinguishes content that must stand alone as its own
  // paragraph (tables, display math, code fences) from content that lives
  // inline within a sentence (inline math, inline code). The draft stage
  // is free to relocate a placeholder anywhere in the rewritten prose —
  // that's fine and expected — but if a "block" placeholder ends up
  // jammed mid-sentence, Markdown's blank-line-before-table/fence rule
  // means it would render as broken syntax instead of a real table. restore()
  // re-establishes that blank-line spacing deterministically, regardless of
  // where the model put the token, so this is never left to prompt luck.
  function stash(match, kind) {
    counter += 1;
    map.set(counter, { content: match, kind });
    return makePlaceholder(counter);
  }

  let out = text;

  // 1. Fenced code blocks first, so their contents (which may contain $,
  // |, backticks, etc.) never get misread as math or table syntax.
  out = out.replace(/```[\s\S]*?```/g, (m) => stash(m, 'block'));

  // 2. Markdown (GFM) pipe tables: a header row, a separator row (e.g.
  // |---|---|), then one or more data rows.
  out = out.replace(
    /^[ \t]*\|.*\|[ \t]*\r?\n[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*\r?\n(?:[ \t]*\|.*\|[ \t]*\r?\n?)+/gm,
    (m) => stash(m.replace(/\r?\n$/, ''), 'block') + '\n'
  );

  // 3. Raw HTML tables — defense in depth for content an HTML-to-Markdown
  // conversion didn't fully clean up.
  out = out.replace(/<table[\s\S]*?<\/table>/gi, (m) => stash(m, 'block'));

  // 4. Display math: $$...$$ and \[...\].
  out = out.replace(/\$\$[\s\S]+?\$\$/g, (m) => stash(m, 'block'));
  out = out.replace(/\\\[[\s\S]+?\\\]/g, (m) => stash(m, 'block'));

  // 5. Inline math \(...\).
  out = out.replace(/\\\([\s\S]+?\\\)/g, (m) => stash(m, 'inline'));

  // 6. Inline math $...$. Heuristic-gated: only protected if the content
  // "looks mathy" (a LaTeX command, a super/subscript, or a letter next to
  // an operator) — so ordinary currency like "$5" or "$10.50" is left as
  // plain prose instead of being swallowed as a false formula.
  out = out.replace(/\$([^$\n]+)\$/g, (m, inner) => {
    const looksMathy =
      /\\[a-zA-Z]+/.test(inner) ||
      /[\^_]/.test(inner) ||
      (/[a-zA-Z]/.test(inner) && /[=+\-*/<>]/.test(inner));
    return looksMathy ? stash(m, 'inline') : m;
  });

  // 7. Inline code spans.
  out = out.replace(/`[^`\n]+`/g, (m) => stash(m, 'inline'));

  return { protectedText: out, map };
}

function restore(text, map) {
  const substituted = text.replace(PLACEHOLDER_RE, (full, idStr) => {
    const entry = map.get(Number(idStr));
    if (!entry) return full;
    // Force blank-line paragraph separation around block content
    // (tables, display math, code fences) no matter where the model
    // placed the token, so it always renders as real Markdown rather
    // than syntax broken by running into surrounding prose.
    return entry.kind === 'block' ? `\n\n${entry.content}\n\n` : entry.content;
  });
  // Collapse any 3+ newline runs the forced spacing above may have
  // introduced back down to a normal single blank line.
  return substituted.replace(/\n{3,}/g, '\n\n').trim();
}

function placeholderCounts(text) {
  const counts = new Map();
  const re = /⟦P(\d+)⟧/g;
  let m;
  while ((m = re.exec(text))) {
    const id = Number(m[1]);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function countsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [id, n] of a) {
    if (b.get(id) !== n) return false;
  }
  return true;
}

// True if a (protected) chunk is nothing but placeholder tokens and
// whitespace — e.g. a standalone table. Such chunks are passed through
// untouched without ever calling the LLM: there's no prose to humanize and
// zero reason to risk an API round trip on pure protected content.
function isPureProtected(text) {
  return /^(?:\s*⟦P\d+⟧\s*)+$/.test(text);
}

module.exports = { protect, restore, placeholderCounts, countsEqual, isPureProtected };
