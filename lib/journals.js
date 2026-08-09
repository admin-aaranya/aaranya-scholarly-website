// The seven journals, keyed by the code that appears in URLs, storage keys
// and every submission record.
//
// This lives in lib/ rather than in routes/auth.js (where it started) because
// it is reference data, not an authentication concern, and half the codebase
// now needs it. Requiring a route module to read a list of journal names made
// lib/ depend on routes/, which is backwards and one refactor away from a
// circular import.
//
// Codes are permanent. Renaming one orphans every submission, issue and
// published URL carrying the old value.

const JOURNALS = {
  alstm: 'Advanced Life Sciences & Translational Medicine',
  ipsb: 'Interdisciplinary Physical Sciences & Bioengineering',
  ghesb: 'Global Health, Environment & Sustainable Biosciences',
  jec: 'Journal of Engineering Confluence',
  jtim: 'Journal of Translational & Integrated Medicine',
  jsamp: 'Journal of Strategic Advisory & Management Practice',
  acfdi: 'Annals of Computational Frontiers & Digital Intelligence',
};

const JOURNAL_CODES = Object.keys(JOURNALS);

// The public journal page for a code, used when linking an article back to
// the journal that published it.
function journalPage(code) {
  return JOURNAL_CODES.includes(code) ? `/journals/${code}.html` : '/index.html';
}

module.exports = { JOURNALS, JOURNAL_CODES, journalPage };
