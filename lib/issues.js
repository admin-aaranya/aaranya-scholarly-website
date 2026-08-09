// Issues -- the containers published articles land in.
//
// A journal issue is the unit readers browse and the unit a citation points
// at. Everything here is pure: no database, no config, no dates read from the
// clock except where a default year is offered. That's deliberate, because
// the rules worth getting right (what counts as a valid issue, when two
// issues collide, how an issue is cited) are exactly the rules worth testing
// without standing anything up.
//
// Release model: an article becomes publicly visible only when BOTH the
// article has been published by an editor AND the issue it sits in has been
// released. One rule, applied in one place (routes/public.js), so there is
// never a second path by which something reaches the public site.
//
// That rule means there is no "online first" -- an accepted article cannot
// appear ahead of its issue. This is a real limitation, not an oversight. If
// online-first is wanted later, the honest implementation is a standing
// "Articles in Press" issue per journal rather than a second visibility rule,
// because a second rule is how confidential material eventually escapes.

const ISSUE_STATUS = {
  PLANNED: 'planned',
  PUBLISHED: 'published',
};

const ISSUE_STATUS_LABELS = {
  [ISSUE_STATUS.PLANNED]: 'Planned',
  [ISSUE_STATUS.PUBLISHED]: 'Published',
};

// Journals have been numbering volumes since the 1600s, but this system has
// not. The lower bound catches a year typed into the volume box; the upper
// bound catches a mistyped year without hard-coding "now" into a pure module.
const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  return n;
}

// Validates and normalizes editor-supplied issue fields. Returns the cleaned
// value alongside the errors so a caller never has to re-parse what it just
// checked.
function validateIssue(input, allJournalCodes) {
  const raw = input || {};
  const errors = [];

  const journalCode = String(raw.journalCode || '').trim();
  if (!journalCode) {
    errors.push('Choose a journal.');
  } else if (Array.isArray(allJournalCodes) && !allJournalCodes.includes(journalCode)) {
    errors.push('Unknown journal.');
  }

  const volume = toPositiveInt(raw.volume);
  if (volume === null) errors.push('Volume must be a whole number of 1 or more.');

  const number = toPositiveInt(raw.number);
  if (number === null) errors.push('Number must be a whole number of 1 or more.');

  const year = toPositiveInt(raw.year);
  if (year === null || year < MIN_YEAR || year > MAX_YEAR) {
    errors.push(`Year must be between ${MIN_YEAR} and ${MAX_YEAR}.`);
  }

  const title = String(raw.title || '').trim();
  const description = String(raw.description || '').trim();

  return {
    ok: errors.length === 0,
    errors,
    value: { journalCode, volume, number, year, title, description },
  };
}

// Two issues collide when they are the same journal, volume and number.
// The year is not part of the identity: "Vol 2, No 1" appearing twice in one
// journal is a data-entry mistake whatever year is attached, and the second
// one would make every citation to the first ambiguous.
function findIssueClash(issues, candidate, ignoreId) {
  return (
    (issues || []).find(
      (i) =>
        i.id !== ignoreId &&
        i.journalCode === candidate.journalCode &&
        Number(i.volume) === Number(candidate.volume) &&
        Number(i.number) === Number(candidate.number)
    ) || null
  );
}

// "Vol. 2, No. 1 (2026)" -- and with a special-issue title appended when
// there is one, which is how PKP, Elsevier and Springer all render it.
function issueLabel(issue) {
  if (!issue) return '';
  const base = `Vol. ${issue.volume}, No. ${issue.number} (${issue.year})`;
  const title = String(issue.title || '').trim();
  return title ? `${base}: ${title}` : base;
}

// "2(1)" -- the form that appears inside a citation.
function issueShortLabel(issue) {
  if (!issue) return '';
  return `${issue.volume}(${issue.number})`;
}

// Newest first: the order a reader expects an archive in.
function sortIssues(issues) {
  return (issues || []).slice().sort((a, b) => {
    if (Number(b.year) !== Number(a.year)) return Number(b.year) - Number(a.year);
    if (Number(b.volume) !== Number(a.volume)) return Number(b.volume) - Number(a.volume);
    return Number(b.number) - Number(a.number);
  });
}

// Articles within an issue: the editor's explicit running order first, then
// by page number, then by title. An issue with nothing set still comes out in
// a stable, sensible order rather than whatever the datastore felt like.
function sortArticlesInIssue(articles) {
  return (articles || []).slice().sort((a, b) => {
    const ao = Number.isFinite(a.articleOrder) ? a.articleOrder : 9999;
    const bo = Number.isFinite(b.articleOrder) ? b.articleOrder : 9999;
    if (ao !== bo) return ao - bo;
    const ap = firstPage(a.pages);
    const bp = firstPage(b.pages);
    if (ap !== bp) return ap - bp;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

// "112-125" -> 112. Returns a large number for unparseable input so that
// articles with no page range sort last rather than first.
function firstPage(pages) {
  const m = /(\d+)/.exec(String(pages || ''));
  return m ? parseInt(m[1], 10) : 999999;
}

// Surname-first author list for a citation: "Sharma R., Patel A." Falls back
// to the whole name when it cannot be split, which is the right behaviour for
// mononyms and for names that do not follow a given/family split.
function citationAuthor(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts.join(' ');
  const family = parts[parts.length - 1];
  const initials = parts
    .slice(0, -1)
    .map((p) => `${p[0].toUpperCase()}.`)
    .join(' ');
  return `${family} ${initials}`;
}

// A plain citation string for the article landing page and the "cite this"
// box. Deliberately close to APA without claiming to be any particular style
// -- the parts a reader needs to find the article again, in a familiar order.
function citationFor(article, issue, journalName) {
  if (!article) return '';
  const authors = (article.authors || []).map((a) => citationAuthor(a.name)).filter(Boolean);
  const authorPart = authors.length ? `${authors.join(', ')} ` : '';
  const year = issue && issue.year ? `(${issue.year}). ` : '';
  const title = article.title ? `${String(article.title).replace(/\.\s*$/, '')}. ` : '';
  const journal = journalName ? `${journalName}` : '';
  const vol = issue ? `, ${issueShortLabel(issue)}` : '';
  const pages = article.pages ? `, ${article.pages}` : '';
  const doi = article.doi ? `. https://doi.org/${String(article.doi).replace(/^https?:\/\/doi\.org\//i, '')}` : '';
  return `${authorPart}${year}${title}${journal}${vol}${pages}${doi}`.trim();
}

module.exports = {
  ISSUE_STATUS,
  ISSUE_STATUS_LABELS,
  MIN_YEAR,
  MAX_YEAR,
  validateIssue,
  findIssueClash,
  issueLabel,
  issueShortLabel,
  sortIssues,
  sortArticlesInIssue,
  firstPage,
  citationAuthor,
  citationFor,
};
