// Plain-text extraction from .docx, with no third-party dependency.
//
// WHY THIS EXISTS AT ALL
// ----------------------
// PDFs do not need it: Vertex AI accepts application/pdf as inline data and
// reads the document itself -- layout, tables and figure captions included --
// which is strictly better than anything text extraction could give it. Word
// files are the exception; Gemini has no .docx input type, so the text has to
// come out on this side.
//
// WHY NOT A LIBRARY
// -----------------
// mammoth and friends pull in a large dependency tree to do HTML conversion
// we would immediately throw away. All we need is one file out of a zip and
// the runs of text inside it, which is about a hundred lines. The trade-off
// is that this code has to be correct on its own, so it is tested against
// real Word output rather than hand-made fixtures.
//
// A .docx is a ZIP archive. The document body lives in word/document.xml.
// This reads the central directory (rather than scanning for local headers,
// which can appear inside compressed data and produce false matches), finds
// that one entry, and inflates it.

const zlib = require('zlib');

const EOCD_SIG = 0x06054b50; // PK\x05\x06  end of central directory
const CEN_SIG = 0x02014b50; // PK\x01\x02  central directory entry
const LOC_SIG = 0x04034b50; // PK\x03\x04  local file header

// Locates the end-of-central-directory record. It sits at the very end of the
// file unless there is a zip comment, so scan backwards over the maximum
// comment length (64 KB) rather than assuming a fixed offset.
function findEocd(buf) {
  const minPos = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

// Walks the central directory and returns the entry for `wanted`, or null.
function findEntry(buf, wanted) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('Not a valid .docx file (no zip directory found).');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CEN_SIG) {
      throw new Error('Not a valid .docx file (corrupt zip directory).');
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    if (name === wanted) return { method, compressedSize, localOffset };
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// Reads and decompresses one entry. Sizes come from the central directory,
// not the local header -- when a writer uses a data descriptor the local
// header's size fields are zero, which is a classic source of bugs in
// hand-rolled zip readers.
function readEntry(buf, entry) {
  const { localOffset, method, compressedSize } = entry;
  if (buf.readUInt32LE(localOffset) !== LOC_SIG) {
    throw new Error('Not a valid .docx file (bad local header).');
  }
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + compressedSize);

  if (method === 0) return data; // stored
  if (method === 8) return zlib.inflateRawSync(data); // deflate
  throw new Error(`Unsupported compression in .docx (method ${method}).`);
}

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeEntities(s) {
  return s
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m])
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

// Turns WordprocessingML into readable plain text.
//
// Only a handful of elements matter for our purpose:
//   <w:t>      a run of literal text
//   <w:p>      paragraph -- becomes a line break
//   <w:tab/>   tab
//   <w:br/>    line break
//   <w:cr/>    carriage return
//
// Everything else (formatting, revision marks, bookmarks, comments anchors)
// is discarded. Deleted text under <w:delText> is deliberately NOT included:
// if the author has tracked changes on, the assistant should read the current
// text, not text the author already removed.
function xmlToText(xml) {
  const out = [];
  const tagOrText = /<([^>]+)>|([^<]+)/g;
  let inText = false;
  let m;

  while ((m = tagOrText.exec(xml)) !== null) {
    const tag = m[1];
    const text = m[2];

    if (text !== undefined) {
      if (inText) out.push(decodeEntities(text));
      continue;
    }

    const name = tag.replace(/^\//, '').split(/[\s/>]/)[0];
    const closing = tag.startsWith('/');
    const selfClosing = tag.endsWith('/');

    if (name === 'w:t') {
      // A self-closing <w:t/> holds nothing; don't flip the flag for it.
      if (!selfClosing) inText = !closing;
    } else if (name === 'w:tab' && !closing) {
      out.push('\t');
    } else if ((name === 'w:br' || name === 'w:cr') && !closing) {
      out.push('\n');
    } else if (name === 'w:p' && closing) {
      out.push('\n');
    }
  }

  return out
    .join('')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Buffer in, plain text out. Throws with a message fit to show an author.
function extractDocxText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('That file does not look like a Word document.');
  }
  // "PK" -- every zip, and therefore every .docx, starts with it. A .doc
  // (the pre-2007 binary format) does not, and cannot be read here.
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error(
      'That looks like an older .doc file. Please save it as .docx or PDF and try again.'
    );
  }

  const entry = findEntry(buffer, 'word/document.xml');
  if (!entry) throw new Error('Could not find the document body inside that Word file.');

  const xml = readEntry(buffer, entry).toString('utf8');
  const text = xmlToText(xml);
  if (!text) throw new Error('That Word document appears to be empty.');
  return text;
}

module.exports = { extractDocxText, xmlToText, findEntry, readEntry };
