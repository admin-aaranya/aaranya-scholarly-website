// The arithmetic behind an article's publication details: where it starts in
// the issue, where it sits in the running order, what its DOI would be, and
// what licence it carries.
//
// Pure functions, no I/O. Everything here decides something an editor would
// otherwise be typing by hand and occasionally getting wrong -- so it is all
// testable without a datastore, and it is all tested.
//
// A NOTE ON "AUTOMATIC"
// ---------------------
// Nothing in this file writes anything. It produces SUGGESTIONS, and the route
// layer only applies one when the editor's own field is empty. That
// distinction matters more than it sounds: an editor who has deliberately
// typed "A17-A24" because the issue uses section prefixes must not have it
// overwritten by a helpful robot the next time they touch an unrelated field.

const LICENCES = [
  {
    key: 'cc-by-4.0',
    label: 'CC BY 4.0 — Attribution',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    note: 'The standard open-access licence. Reuse of any kind is permitted with credit. Required or expected by most funders, and what DOAJ treats as fully open.',
  },
  {
    key: 'cc-by-sa-4.0',
    label: 'CC BY-SA 4.0 — Attribution, ShareAlike',
    url: 'https://creativecommons.org/licenses/by-sa/4.0/',
    note: 'As CC BY, but derivative works must carry the same licence.',
  },
  {
    key: 'cc-by-nc-4.0',
    label: 'CC BY-NC 4.0 — Attribution, NonCommercial',
    url: 'https://creativecommons.org/licenses/by-nc/4.0/',
    note: 'Blocks commercial reuse. Be aware this fails some funder mandates (Plan S among them) and is not counted as fully open by every indexer.',
  },
  {
    key: 'cc-by-nc-nd-4.0',
    label: 'CC BY-NC-ND 4.0 — Attribution, NonCommercial, NoDerivatives',
    url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
    note: 'The most restrictive Creative Commons option: no commercial use and no adaptations, including translations.',
  },
  {
    key: 'cc0-1.0',
    label: 'CC0 1.0 — Public domain dedication',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    note: 'All rights waived. Uncommon for articles; sometimes used for datasets.',
  },
];

const DEFAULT_LICENCE = 'cc-by-4.0';

const LICENCES_BY_KEY = LICENCES.reduce((acc, l) => {
  acc[l.key] = l;
  return acc;
}, {});

// Historic records hold free text, because the field used to be an open input.
// Anything unrecognised is preserved and shown as-is rather than being
// coerced into a licence nobody chose.
function licenceFor(key) {
  const raw = String(key || '').trim();
  if (!raw) return null;
  return LICENCES_BY_KEY[raw] || { key: raw, label: raw, url: '', note: '', unknown: true };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

// "112-125" -> { start: 112, end: 125 }. Also accepts en and em dashes, which
// is what you get when a range has been through Word.
// A single page ("7") is a range of one. Anything else returns null.
function parsePageRange(pages) {
  const raw = String(pages == null ? '' : pages).trim();
  if (!raw) return null;
  const m = /^(\d+)\s*(?:[-‐-―]\s*(\d+))?$/.exec(raw);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] === undefined ? start : parseInt(m[2], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

function formatPageRange(start, count) {
  const s = Number(start);
  const n = Number(count);
  if (!Number.isFinite(s) || s < 1) return '';
  if (!Number.isFinite(n) || n < 1) return '';
  return n === 1 ? String(s) : `${s}-${s + n - 1}`;
}

// The first page this article can occupy without colliding with anything
// already placed in the issue.
//
// Deliberately the highest end page + 1, not the count of articles: articles
// are not one page long, and an issue is often assembled out of order. Any
// article whose range cannot be parsed is skipped rather than assumed, so one
// oddly-formatted entry cannot silently push everything else on top of it.
function nextStartPage(articlesInIssue, excludeId) {
  let highest = 0;
  (articlesInIssue || []).forEach((a) => {
    if (!a || (excludeId && a.id === excludeId)) return;
    const range = parsePageRange(a.pages);
    if (range && range.end > highest) highest = range.end;
  });
  return highest + 1;
}

// Where this article would sit, given how long its PDF is.
// Returns null when the length is unknown -- see lib/pdf-pages.js on why a
// guess is unacceptable here.
function suggestPages(articlesInIssue, excludeId, pageCount) {
  const n = Number(pageCount);
  if (!Number.isFinite(n) || n < 1) return null;
  return formatPageRange(nextStartPage(articlesInIssue, excludeId), n);
}

// Two articles claiming the same pages. Not blocked -- an issue mid-assembly
// legitimately passes through states like this, and an editor renumbering a
// table of contents would find a hard error maddening -- but always surfaced,
// because it is invisible until a reader finds it.
function pageOverlaps(articlesInIssue, excludeId, pages) {
  const mine = parsePageRange(pages);
  if (!mine) return [];
  return (articlesInIssue || []).filter((a) => {
    if (!a || (excludeId && a.id === excludeId)) return false;
    const other = parsePageRange(a.pages);
    if (!other) return false;
    return mine.start <= other.end && other.start <= mine.end;
  });
}

// ---------------------------------------------------------------------------
// Order in issue
// ---------------------------------------------------------------------------

// First article in an issue is 1; every later one is a step past the highest
// already taken. Gaps left by a removed article are not backfilled -- an
// editor who deliberately left position 3 empty should keep it.
function nextArticleOrder(articlesInIssue, excludeId) {
  let highest = 0;
  (articlesInIssue || []).forEach((a) => {
    if (!a || (excludeId && a.id === excludeId)) return;
    const order = Number(a.articleOrder);
    if (Number.isFinite(order) && order > highest) highest = order;
  });
  return highest + 1;
}

function duplicateOrder(articlesInIssue, excludeId, order) {
  const want = Number(order);
  if (!Number.isFinite(want)) return [];
  return (articlesInIssue || []).filter(
    (a) => a && !(excludeId && a.id === excludeId) && Number(a.articleOrder) === want
  );
}

// ---------------------------------------------------------------------------
// DOI
// ---------------------------------------------------------------------------

// A DOI has two halves: a prefix Crossref assigns to the publisher (10.xxxxx)
// and a suffix the publisher invents. We can only invent the second half.
//
// WITHOUT A REGISTERED PREFIX THIS RETURNS NOTHING, ON PURPOSE.
// A well-formed DOI that resolves nowhere is worse than an empty field: it
// looks authoritative, authors put it on CVs and in reference lists, readers
// click it and land on an error page, and DOAJ and Scopus assessors check that
// a sample of DOIs actually resolve. An empty field is merely incomplete; a
// dead DOI is a false claim that is hard to withdraw once cited.
//
// Minting the string is also not the same as registering it. Even with a
// prefix configured, the article is only findable once the metadata has been
// deposited with Crossref -- which this platform does not yet do.
//
// The suffix is deterministic, so the same article always produces the same
// DOI and a re-run cannot mint a second identifier for one article:
//
//     10.12345/alstm.2026.2.1.4
//     prefix    journal year vol issue order
function generateDoi({ prefix, journalCode, year, volume, number, articleOrder }) {
  const p = String(prefix || '').trim().replace(/\/+$/, '');
  if (!p || !/^10\.\d{4,9}$/.test(p)) return '';

  const code = String(journalCode || '').trim().toLowerCase();
  const parts = [code, year, volume, number, articleOrder]
    .map((v) => (v === undefined || v === null ? '' : String(v).trim()))
    .filter(Boolean);

  // Every component identifies the article's position. Missing any of them
  // means the DOI would not be unique, so no DOI is offered.
  if (parts.length < 5) return '';
  return `${p}/${parts.join('.')}`;
}

// Accepts a pasted doi.org URL or a "doi:" prefix and stores the bare form, so
// half the records do not carry a prefix the other half lack.
function normaliseDoi(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim();
}

module.exports = {
  LICENCES,
  LICENCES_BY_KEY,
  DEFAULT_LICENCE,
  licenceFor,
  parsePageRange,
  formatPageRange,
  nextStartPage,
  suggestPages,
  pageOverlaps,
  nextArticleOrder,
  duplicateOrder,
  generateDoi,
  normaliseDoi,
};
