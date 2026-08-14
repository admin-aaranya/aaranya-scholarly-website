// How many pages are in this PDF?
//
// WHY THIS EXISTS
// ---------------
// Pages in an issue run continuously: article 1 starts at page 1, article 2
// starts wherever article 1 finished. To work out where an article ends you
// need to know how long it is, and the only place that is recorded is the PDF
// galley itself.
//
// WHY NOT A LIBRARY
// -----------------
// Same reasoning as lib/docx-text.js. pdf-lib and pdf-parse exist to build and
// render PDFs; we want a single integer. The whole job is finding the page
// tree root and reading its /Count, which is a few dozen lines.
//
// THE ONE RULE HERE
// -----------------
// A wrong number is far worse than no number. If pagination is wrong every
// citation to the article is wrong, and citations are not correctable after
// the fact -- they are already in other people's reference lists. So every
// uncertain path in this file returns null, and the caller falls back to
// asking the editor. Nothing here guesses.
//
// HOW A PDF SAYS HOW LONG IT IS
// -----------------------------
// Objects look like:
//
//     3 0 obj
//     << /Type /Pages /Kids [4 0 R 5 0 R] /Count 12 >>
//     endobj
//
// The root of the page tree carries /Count: the total number of leaf pages
// below it. Intermediate nodes carry their own subtree counts, so picking the
// wrong node gives a plausible-looking but wrong answer -- which is exactly
// the failure this module must not have. Hence: take the LARGEST /Count found
// on a /Type /Pages node, since the root's count is by definition the total
// and no subtree can exceed it.
//
// The cross-reference table would let us find the true root properly, but it
// can be a compressed xref stream, which would mean implementing object
// streams and predictors. The largest-count rule reaches the same answer on
// every well-formed file without any of that.

// Objects are matched whole -- "N G obj ... endobj" -- rather than by looking
// in a window around each /Type /Pages. A window straddles object boundaries,
// so an intermediate node sitting next to the root in the file would have the
// root's /Count read as its own, or vice versa. That produces a plausible
// wrong number, which is the one outcome this module exists to avoid.
//
// Non-greedy, so the first "endobj" ends the object. A stream containing the
// literal bytes "endobj" therefore truncates it -- costing us a /Count we
// would otherwise have seen, which fails soft to null rather than wrong.
const PDF_OBJECT = /\d+\s+\d+\s+obj\b([\s\S]*?)endobj/g;
const IS_PAGES_NODE = /\/Type\s*\/Pages\b/;
const COUNT_IN_NODE = /\/Count\s+(\d+)/;

// A /Type /Page (singular) leaf. Counting these is the fallback for producers
// that omit /Count, and is only trusted when the primary method finds nothing.
const PAGE_LEAF = /\/Type\s*\/Page[^s]/g;

// Encrypted PDFs have their strings and streams obscured, so any count read
// out of one is unreliable. Better to admit that than to publish a guess.
const ENCRYPTED = /\/Encrypt\b/;

// Object streams (PDF 1.5+) can hide the page tree inside a compressed stream,
// where none of the patterns above will see it. Detected so the caller can
// tell "this PDF has no pages" apart from "this PDF hides them from us".
const OBJECT_STREAM = /\/Type\s*\/ObjStm\b/;

/**
 * @param {Buffer} buffer raw PDF bytes
 * @returns {number|null} page count, or null when it cannot be established
 */
function pdfPageCount(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) return null;

  // latin1 maps every byte to one character, so byte offsets and string
  // indices stay aligned and binary stream data cannot throw off a match.
  const text = buffer.toString('latin1');

  if (!text.startsWith('%PDF-')) return null;
  if (ENCRYPTED.test(text)) return null;

  let best = 0;
  let match;
  PDF_OBJECT.lastIndex = 0;
  while ((match = PDF_OBJECT.exec(text)) !== null) {
    const body = match[1];
    if (!IS_PAGES_NODE.test(body)) continue;
    // Within one object, /Count may sit either side of /Type. Both are in
    // this body and nothing from a neighbouring object is.
    const count = COUNT_IN_NODE.exec(body);
    if (count) {
      const n = parseInt(count[1], 10);
      if (Number.isFinite(n) && n > best) best = n;
    }
  }
  if (best > 0) return best;

  // No /Count anywhere. If the page tree is inside an object stream we simply
  // cannot see it, and counting visible leaves would undercount.
  if (OBJECT_STREAM.test(text)) return null;

  PAGE_LEAF.lastIndex = 0;
  let leaves = 0;
  while (PAGE_LEAF.exec(text) !== null) leaves += 1;
  return leaves > 0 ? leaves : null;
}

module.exports = { pdfPageCount };
