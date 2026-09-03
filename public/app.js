(() => {
  const inputText = document.getElementById('inputText');
  const inputCount = document.getElementById('inputCount');
  const outputCount = document.getElementById('outputCount');
  const outputText = document.getElementById('outputText');
  const humanizeBtn = document.getElementById('humanizeBtn');
  const btnLabel = humanizeBtn.querySelector('.btn-label');
  const btnSpinner = humanizeBtn.querySelector('.btn-spinner');
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const progressLabel = document.getElementById('progressLabel');
  const copyBtn = document.getElementById('copyBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const copyInputBtn = document.getElementById('copyInputBtn');
  const diffToggle = document.getElementById('diffToggle');
  const errorNote = document.getElementById('errorNote');
  const protectedNote = document.getElementById('protectedNote');
  const intensityBtns = Array.from(document.querySelectorAll('.intensity-btn'));

  let intensity = 'balanced';
  let finalText = ''; // Markdown, with formulas/tables restored
  let busy = false;

  // ---------------------------------------------------------------------
  // Markdown conversion (Turndown, GFM tables) — this is the bridge
  // between the rich-text input box and the plain-text pipeline Verso's
  // server already speaks. Whatever the author pastes (Word, Google Docs,
  // a webpage) becomes clean Markdown, LaTeX-style math ($...$, $$...$$)
  // and pipe tables pass through untouched, and the result renders back
  // with real tables and rendered formulas.
  // ---------------------------------------------------------------------
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    bulletListMarker: '-',
  });
  if (window.turndownPluginGfm) turndownService.use(window.turndownPluginGfm.gfm);

  function htmlToMarkdown(html) {
    return turndownService.turndown(html || '');
  }

  function inputMarkdown() {
    return htmlToMarkdown(inputText.innerHTML).trim();
  }

  // ---------------------------------------------------------------------
  // Paste sanitization — Word/Google Docs/webpage paste arrives as a
  // clipboard "text/html" payload carrying a mess of inline styles,
  // classes, and Office-only tags. Strip it down to a small allowlist of
  // structural tags (so formatting, lists, and — critically — tables
  // survive) with all attributes removed except the ones tables need.
  // ---------------------------------------------------------------------
  const ALLOWED_TAGS = new Set([
    'P', 'BR', 'DIV', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'UL', 'OL', 'LI',
    'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
    'SUP', 'SUB', 'CODE', 'PRE', 'BLOCKQUOTE', 'A', 'HR',
  ]);
  const ALLOWED_ATTRS = { A: ['href'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'] };

  function sanitizeNode(node) {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) {
        node.removeChild(child); // comments, Office conditional markup, etc.
        continue;
      }
      const tag = child.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IMG' || tag === 'META' || tag === 'LINK') {
        node.removeChild(child);
        continue;
      }
      if (!ALLOWED_TAGS.has(tag)) {
        // Unwrap: keep the text/children, drop the wrapping element itself.
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        node.removeChild(child);
        continue;
      }
      const allowed = ALLOWED_ATTRS[tag] || [];
      for (const attr of Array.from(child.attributes)) {
        if (!allowed.includes(attr.name)) child.removeAttribute(attr.name);
      }
      sanitizeNode(child);
    }
  }

  // Most pasted tables (Word, Docs, webpages) don't mark their header row
  // with proper <th> cells — just a first <tr> of plain <td>s. Turndown's
  // GFM table rule requires a real heading row or it gives up and keeps
  // the table as raw HTML, so promote the first row here to get clean
  // Markdown pipe-table output instead.
  function promoteTableHeaders(root) {
    root.querySelectorAll('table').forEach((table) => {
      const firstRow = table.rows && table.rows[0];
      if (!firstRow) return;
      const cells = Array.from(firstRow.cells);
      if (cells.length && cells.every((c) => c.tagName === 'TD')) {
        cells.forEach((td) => {
          const th = document.createElement('th');
          th.innerHTML = td.innerHTML;
          td.replaceWith(th);
        });
      }
    });
  }

  // Word/Docs/webpage paste often wraps each table cell's text in its own
  // <p>, which trips up Turndown's table-cell rule into emitting stray
  // blank lines inside cells and breaking the one-row-per-line Markdown
  // table shape. A paragraph mark inside a cell carries no meaning we
  // care about here, so flatten it.
  function flattenTableCellParagraphs(root) {
    root.querySelectorAll('td, th').forEach((cell) => {
      cell.querySelectorAll('p').forEach((p) => {
        while (p.firstChild) p.parentNode.insertBefore(p.firstChild, p);
        p.remove();
      });
    });
  }

  // KaTeX and MathJax (what ChatGPT, Claude.ai, and most math-rendering
  // sites use) render a formula as a tree of positioned <span>s — a
  // fraction is a numerator span stacked over a denominator span via CSS,
  // with no character that "means" the fraction bar or division in the
  // text itself. When a browser flattens that to plain text for the
  // clipboard, it just concatenates the DOM text nodes in source order,
  // which scrambles numerator/denominator/exponent structure entirely
  // (this is exactly the "Pre-test ScorePost-test Score-Pre-test Score"
  // scrambling — the layout, not the reading order).
  //
  // Both libraries, though, embed the ORIGINAL LaTeX source in the HTML
  // for screen readers: KaTeX in <annotation encoding="application/x-tex">
  // inside a hidden .katex-mathml block, MathJax similarly (and sometimes
  // in a sibling <script type="math/tex">). That source is still present
  // in what the browser puts on the clipboard even though it's not
  // visible on screen. Recover it and replace the whole rendered widget
  // with plain $...$ / $$...$$ text — the exact, structurally-correct
  // formula — before the general sanitizer strips the MathML tags away as
  // unrecognized markup.
  function recoverMathAnnotations(root) {
    const sources = Array.from(
      root.querySelectorAll('annotation[encoding="application/x-tex"], script[type="math/tex"]')
    );
    for (const src of sources) {
      const latex = (src.textContent || '').trim();
      if (!latex) continue;
      const target =
        src.closest('.katex-display') ||
        src.closest('mjx-container[display="true"]') ||
        src.closest('.katex') ||
        src.closest('mjx-container') ||
        src.parentElement;
      if (!target || !target.parentNode) continue;
      const isDisplay =
        typeof target.matches === 'function' &&
        target.matches('.katex-display, mjx-container[display="true"]');
      const wrapped = isDisplay ? `$$${latex}$$` : `$${latex}$`;
      target.replaceWith(document.createTextNode(wrapped));
    }
  }

  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    recoverMathAnnotations(doc.body);
    sanitizeNode(doc.body);
    flattenTableCellParagraphs(doc.body);
    promoteTableHeaders(doc.body);
    return doc.body.innerHTML;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function plainTextToHtml(text) {
    return text
      .split(/\r\n|\r|\n/)
      .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : '<p><br></p>'))
      .join('');
  }

  function insertHtmlAtCursor(html) {
    inputText.focus();
    let inserted = false;
    if (document.queryCommandSupported && document.queryCommandSupported('insertHTML')) {
      try {
        inserted = document.execCommand('insertHTML', false, html);
      } catch {
        inserted = false;
      }
    }
    if (inserted) return;

    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      inputText.insertAdjacentHTML('beforeend', html);
      return;
    }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const frag = range.createContextualFragment(html);
    const lastNode = frag.lastChild;
    range.insertNode(frag);
    if (lastNode) {
      range.setStartAfter(lastNode);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  inputText.addEventListener('paste', (e) => {
    e.preventDefault();
    const html = e.clipboardData && e.clipboardData.getData('text/html');
    const plain = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
    const insertHtml = html && html.trim() ? sanitizeHtml(html) : plainTextToHtml(plain);
    insertHtmlAtCursor(insertHtml);
    updateInputCount();
  });

  function countWords(str) {
    const m = str.trim().match(/\S+/g);
    return m ? m.length : 0;
  }

  function updateInputCount() {
    const words = countWords(inputText.innerText || '');
    inputCount.textContent = `${words} words`;
    copyInputBtn.disabled = words === 0;
  }
  inputText.addEventListener('input', updateInputCount);
  updateInputCount();

  function flashCopied(btn) {
    const label = btn.querySelector('.btn-text');
    const original = label ? label.textContent : btn.textContent;
    if (label) label.textContent = 'Copied';
    else btn.textContent = 'Copied ✓';
    btn.classList.add('is-done');
    setTimeout(() => {
      if (label) label.textContent = original;
      else btn.textContent = original;
      btn.classList.remove('is-done');
    }, 1400);
  }

  async function copyToClipboard(text, btn) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(btn);
    } catch {
      errorNote.hidden = false;
      errorNote.textContent = 'Could not copy — select and copy manually.';
    }
  }

  copyInputBtn.addEventListener('click', () => copyToClipboard(inputMarkdown(), copyInputBtn));

  intensityBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (busy) return;
      intensity = btn.dataset.value;
      intensityBtns.forEach((b) => b.classList.toggle('is-active', b === btn));
    });
  });

  diffToggle.addEventListener('change', () => {
    renderOutput();
  });

  // --- lightweight word-level diff (LCS-based) -----------------------------
  function tokenize(str) {
    return str.match(/\S+|\s+/g) || [];
  }

  function diffWords(oldStr, newStr) {
    const a = tokenize(oldStr);
    const b = tokenize(newStr);
    const n = a.length, m = b.length;

    // Cap cost for very large paragraphs — fall back to a coarse diff.
    if (n * m > 400000) {
      return [{ type: 'del', text: oldStr }, { type: 'add', text: newStr }];
    }

    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ type: 'eq', text: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', text: a[i] }); i++; }
      else { ops.push({ type: 'add', text: b[j] }); j++; }
    }
    while (i < n) { ops.push({ type: 'del', text: a[i] }); i++; }
    while (j < m) { ops.push({ type: 'add', text: b[j] }); j++; }

    // merge adjacent same-type ops
    const merged = [];
    for (const op of ops) {
      const last = merged[merged.length - 1];
      if (last && last.type === op.type) last.text += op.text;
      else merged.push({ ...op });
    }
    return merged;
  }

  // Renders one diffed op-stream as a fragment of Markdown source, with the
  // diff spans riding along as raw <ins>/<del> HTML. escapeHtml only touches
  // &, <, > — every Markdown syntax character (#, *, |, $, -) passes through
  // untouched — so this is valid Markdown source, not just escaped diff
  // text. marked treats <ins>/<del> as inline HTML passthrough and parses
  // everything else (headings, lists, tables, emphasis) normally around
  // them.
  function diffToMarkdown(original, rewritten) {
    const ops = diffWords(original, rewritten);
    let diffMarkdown = '';
    for (const op of ops) {
      const safe = escapeHtml(op.text);
      if (op.type === 'eq') diffMarkdown += safe;
      else if (op.type === 'add') diffMarkdown += `<ins>${safe}</ins>`;
      else diffMarkdown += `<del>${safe}</del>`;
    }
    return diffMarkdown;
  }

  function renderDiffParagraph(original, rewritten) {
    // A "chunk" from the server is often several Markdown blocks packed
    // together (a heading, then a paragraph, then a list, ...). Diffing the
    // whole thing as one flat token stream lets the LCS algorithm match
    // words across unrelated blocks when several small edits happen
    // throughout the chunk, which can wrap a structural marker like "##",
    // "-", or "|" in a stray <ins>/<del> — breaking Markdown's rule that
    // those characters must sit literally at the start of a line. Diffing
    // block-by-block (blank-line-separated, the same unit protect.js and
    // the server's chunker already treat as atomic) keeps each block's
    // local diff self-contained, so markers stay put.
    const originalBlocks = original.split(/\n{2,}/);
    const rewrittenBlocks = rewritten.split(/\n{2,}/);
    const diffMarkdown =
      originalBlocks.length === rewrittenBlocks.length
        ? originalBlocks.map((b, i) => diffToMarkdown(b, rewrittenBlocks[i])).join('\n\n')
        : diffToMarkdown(original, rewritten); // block counts drifted — fall back to a single whole-chunk diff

    const block = document.createElement('div');
    block.className = 'output-block';
    block.innerHTML = marked.parse(diffMarkdown);
    try {
      renderMathInElement(block, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
      });
    } catch {
      // KaTeX not available or nothing to render — the diffed text is still fine.
    }

    const copyParaBtn = document.createElement('button');
    copyParaBtn.type = 'button';
    copyParaBtn.className = 'para-copy-btn';
    copyParaBtn.title = 'Copy this paragraph';
    const copyIcon =
      '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6.5" y="6.5" width="10" height="10" rx="1.6"/><path d="M4 13V4.6C4 4 4.6 3.5 5.2 3.5H13"/></svg>';
    copyParaBtn.innerHTML = copyIcon;
    copyParaBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(rewritten);
        copyParaBtn.classList.add('is-done');
        copyParaBtn.innerHTML = '✓';
        setTimeout(() => {
          copyParaBtn.classList.remove('is-done');
          copyParaBtn.innerHTML = copyIcon;
        }, 1200);
      } catch {
        errorNote.hidden = false;
        errorNote.textContent = 'Could not copy — select and copy manually.';
      }
    });
    block.appendChild(copyParaBtn);

    return block;
  }

  // Chunk-level records collected as the stream comes in, so the view can
  // be re-rendered (diff <-> clean) without re-running the request.
  let chunkRecords = [];

  function renderOutput() {
    const showDiff = diffToggle.checked;
    // Both diff and clean views render real Markdown now, so the heading/
    // list/table styles under .rendered apply either way.
    outputText.classList.add('rendered');

    if (showDiff) {
      outputText.innerHTML = '';
      for (const rec of chunkRecords) {
        outputText.appendChild(renderDiffParagraph(rec.original, rec.rewritten));
      }
      if (!chunkRecords.length) {
        outputText.innerHTML = '<p class="placeholder">Your humanized manuscript will appear here, paragraph by paragraph, as it\'s ready.</p>';
      }
      return;
    }

    // Clean rendered view: real Markdown -> HTML (headings, lists, tables),
    // then KaTeX renders any $...$ / $$...$$ formulas in place.
    const source = finalText || chunkRecords.map((r) => r.rewritten).join('\n\n');
    if (!source.trim()) {
      outputText.innerHTML = '<p class="placeholder">Your humanized manuscript will appear here, paragraph by paragraph, as it\'s ready.</p>';
      return;
    }
    outputText.innerHTML = marked.parse(source);
    try {
      renderMathInElement(outputText, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
      });
    } catch {
      // KaTeX not available or nothing to render — the raw text is still fine.
    }
  }

  function setBusy(state) {
    busy = state;
    humanizeBtn.disabled = state;
    btnSpinner.hidden = !state;
    btnLabel.textContent = state ? 'Humanizing…' : 'Humanize';
    intensityBtns.forEach((b) => (b.disabled = state));
  }

  async function humanize() {
    const text = inputMarkdown();
    if (!text || busy) return;

    setBusy(true);
    errorNote.hidden = true;
    errorNote.textContent = '';
    protectedNote.hidden = true;
    protectedNote.textContent = '';
    chunkRecords = [];
    outputText.classList.add('rendered');
    outputText.innerHTML = '';
    copyBtn.disabled = true;
    downloadBtn.disabled = true;
    finalText = '';
    outputCount.textContent = '0 words';
    progressWrap.hidden = false;
    progressFill.style.width = '0%';
    progressLabel.textContent = 'Reading your draft…';

    try {
      const res = await fetch('/api/humanize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, intensity }),
      });

      if (!res.ok || !res.body) {
        const errBody = await res.text().catch(() => '');
        throw new Error(errBody || `Server responded ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawError = false;
      let protectedCount = 0;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);

          if (event.type === 'start') {
            progressLabel.textContent = `Humanizing 1 of ${event.total}…`;
          } else if (event.type === 'progress') {
            const pct = Math.round((event.index / event.total) * 100);
            progressFill.style.width = pct + '%';
            progressLabel.textContent =
              event.index < event.total
                ? `Humanizing ${event.index + 1} of ${event.total}…`
                : `Finishing up…`;

            chunkRecords.push({ original: event.original, rewritten: event.rewritten });
            if (diffToggle.checked) {
              outputText.appendChild(renderDiffParagraph(event.original, event.rewritten));
              outputText.scrollTop = outputText.scrollHeight;
            }

            if (event.error) {
              sawError = true;
              errorNote.hidden = false;
              errorNote.textContent = `A passage couldn't be rewritten and was left as-is (${event.error.slice(0, 90)})`;
            } else if (event.protectedNote) {
              protectedCount += 1;
              protectedNote.hidden = false;
              protectedNote.textContent =
                protectedCount === 1
                  ? 'Kept 1 passage unchanged as a precaution.'
                  : `Kept ${protectedCount} passages unchanged as a precaution.`;
            }
          } else if (event.type === 'done') {
            finalText = event.text;
            outputCount.textContent = `${countWords(finalText)} words`;
            progressLabel.textContent = sawError ? 'Done, with a note above.' : 'Done.';
            progressFill.style.width = '100%';
            copyBtn.disabled = false;
            downloadBtn.disabled = false;
            if (!diffToggle.checked) renderOutput();
          }
        }
      }
    } catch (err) {
      errorNote.hidden = false;
      errorNote.textContent = `Something went wrong: ${err.message || err}`;
      progressLabel.textContent = 'Stopped.';
    } finally {
      setBusy(false);
      setTimeout(() => { progressWrap.hidden = true; }, 1200);
    }
  }

  humanizeBtn.addEventListener('click', humanize);

  copyBtn.addEventListener('click', () => copyToClipboard(finalText, copyBtn));

  downloadBtn.addEventListener('click', () => {
    if (!finalText) return;
    const blob = new Blob([finalText], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'humanized.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  inputText.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') humanize();
  });

  renderOutput();
})();
