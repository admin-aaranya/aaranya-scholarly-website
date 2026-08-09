// Building an HTML full-text galley from an accepted manuscript.
//
// A galley is what a reader actually opens. Most of the time that is a PDF
// the editorial office typeset and uploaded, and nothing here is involved.
// This module covers the other one: turning the accepted Word file into
// readable, indexable HTML so the article has a full text on the web and not
// just a download link.
//
// What this is NOT: a typesetting engine. It does not preserve fonts,
// figures, equations or table layout, because the input it works from
// (lib/docx-text.js) is plain text by design. What it produces is a clean,
// correctly structured reading copy -- headings, paragraphs, a reference
// list -- which is what search engines index and what a screen reader can
// follow. The PDF remains the version of record, and the UI says so rather
// than letting an editor discover it.
//
// SECURITY: every character of manuscript content passes through esc()
// before it reaches the output. That is what makes a generated galley safe
// to render inside our own page, and it is the entire reason generated and
// uploaded galleys are treated differently downstream -- an uploaded .html
// is a third party's script running on our origin, so it is only ever served
// as a download. See routes/public.js.

const { extractDocxText } = require('./docx-text');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Headings a research paper actually uses. Matched case-insensitively and
// with any leading numbering ("3.", "3.1", "IV.") stripped first.
const SECTION_WORDS = [
  'abstract',
  'keywords',
  'introduction',
  'background',
  'related work',
  'literature review',
  'materials and methods',
  'methods and materials',
  'materials & methods',
  'methods',
  'methodology',
  'experimental',
  'results',
  'results and discussion',
  'findings',
  'discussion',
  'conclusion',
  'conclusions',
  'conclusions and future work',
  'limitations',
  'future work',
  'recommendations',
  'acknowledgement',
  'acknowledgements',
  'acknowledgment',
  'acknowledgments',
  'funding',
  'author contributions',
  'conflict of interest',
  'conflicts of interest',
  'declaration of interest',
  'data availability',
  'ethics statement',
  'ethical approval',
  'supplementary material',
  'abbreviations',
  'references',
  'bibliography',
  'works cited',
];

const NUMBER_PREFIX = /^\s*(?:\d+(?:\.\d+)*\.?|[ivxlcdm]+\.|[A-Z]\.)\s+/i;

function stripNumbering(line) {
  return String(line || '').replace(NUMBER_PREFIX, '').trim();
}

// Is this line a section heading?
//
// Three signals, in descending order of confidence: it names a known section,
// it is short and fully capitalised, or it is short, numbered and has no
// terminal punctuation. Requiring shortness on the last two is what keeps a
// one-line sentence in capitals from becoming an <h2>.
function looksLikeHeading(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.length > 90) return false;

  const bare = stripNumbering(raw).replace(/[:.]\s*$/, '').trim();
  const lower = bare.toLowerCase();
  if (SECTION_WORDS.includes(lower)) return true;

  const letters = bare.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && bare.length <= 60 && bare === bare.toUpperCase() && /[A-Z]/.test(bare)) {
    return true;
  }

  if (NUMBER_PREFIX.test(raw) && bare.length <= 60 && !/[.?!]$/.test(bare) && /^[A-Z]/.test(bare)) {
    return true;
  }

  return false;
}

function isReferencesHeading(line) {
  const bare = stripNumbering(String(line || '')).replace(/[:.]\s*$/, '').trim().toLowerCase();
  return bare === 'references' || bare === 'bibliography' || bare === 'works cited';
}

// Normalizes the whitespace inside a paragraph without touching its content.
function tidy(line) {
  return String(line || '').replace(/\s+/g, ' ').trim();
}

// Turns the extracted plain text into structured HTML.
//
// `article` supplies the title and the abstract so the generator can drop a
// duplicate title line from the top of the manuscript -- authors almost
// always repeat it, and two <h1>s on a page is both ugly and wrong.
function textToHtml(text, article) {
  const meta = article || {};
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/ /g, ' '))
    .map((l) => l.trimEnd());

  const out = [];
  let inReferences = false;
  let refItems = [];
  let sections = 0;
  let paragraphs = 0;
  let words = 0;

  const titleNorm = tidy(meta.title || '').toLowerCase();

  function flushReferences() {
    if (!refItems.length) return;
    out.push('<ol class="galley-refs">');
    refItems.forEach((r) => out.push(`<li>${esc(r)}</li>`));
    out.push('</ol>');
    refItems = [];
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = tidy(lines[i]);
    if (!line) continue;

    // Skip the author's own repeat of the title, but only near the top --
    // a phrase matching the title further down is part of the text.
    if (i < 8 && titleNorm && line.toLowerCase() === titleNorm) continue;

    if (looksLikeHeading(line)) {
      flushReferences();
      inReferences = isReferencesHeading(line);
      const heading = stripNumbering(line).replace(/[:.]\s*$/, '').trim() || line;
      out.push(`<h2>${esc(heading)}</h2>`);
      sections += 1;
      continue;
    }

    if (inReferences) {
      // Numbered or bracketed reference markers become list numbering
      // instead of being repeated inside the item text.
      refItems.push(line.replace(/^\s*(?:\[\d+\]|\(\d+\)|\d+\.)\s*/, ''));
      continue;
    }

    out.push(`<p>${esc(line)}</p>`);
    paragraphs += 1;
    words += line.split(/\s+/).filter(Boolean).length;
  }

  flushReferences();

  return { html: out.join('\n'), sections, paragraphs, words };
}

// Reads a buffered .docx and returns a galley body.
//
// Throws with a message meant to be shown to an editor verbatim -- every
// failure here has an obvious next action, and "generation failed" would hide
// all of them behind one useless sentence.
function generateHtmlGalley({ buffer, fileName, article }) {
  const name = String(fileName || '');
  const ext = (/\.[a-z0-9]+$/i.exec(name) || [''])[0].toLowerCase();

  if (ext === '.pdf') {
    throw new Error(
      'HTML full text can only be generated from a Word file. This source is a PDF — ' +
        'upload the .docx as the final copyedited file, or add the PDF as a PDF galley instead.'
    );
  }
  if (ext === '.doc') {
    throw new Error(
      'This is an old binary .doc file, which cannot be read directly. Open it in Word and ' +
        'save it as .docx, then try again.'
    );
  }
  if (ext !== '.docx') {
    throw new Error(`Cannot build HTML full text from a ${ext || 'file'} of this type. Use a .docx.`);
  }
  if (!buffer || !buffer.length) {
    throw new Error('That file is empty.');
  }

  const text = extractDocxText(buffer);
  if (!text || !text.trim()) {
    throw new Error('No readable text was found in that document.');
  }

  const built = textToHtml(text, article);
  if (!built.paragraphs) {
    throw new Error('That document produced no readable paragraphs.');
  }

  return {
    html: built.html,
    stats: {
      sections: built.sections,
      paragraphs: built.paragraphs,
      words: built.words,
    },
  };
}

module.exports = {
  esc,
  looksLikeHeading,
  isReferencesHeading,
  stripNumbering,
  textToHtml,
  generateHtmlGalley,
};
