// File storage -- uploaded manuscripts, supplementary files, and reviewer
// attachments.
//
// Two backends, mirroring db.js:
//
//   Cloud Storage -- production. Set GCS_BUCKET.
//   Local disk    -- development. Files go under data/uploads/ when no
//                    bucket is configured, so the app runs with nothing but
//                    Node installed.
//
// `storedFileName` is the object key in both cases -- a GCS key, or a path
// relative to data/uploads/. Nothing above this layer needs to know which.

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { GCS_BUCKET, DATA_DIR } = require('../config');

const ALLOWED_EXT = new Set(['.pdf', '.doc', '.docx']);
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_SUPPLEMENTARY = 5;

const USE_GCS = Boolean(GCS_BUCKET);
const LOCAL_UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

let bucket = null;
if (USE_GCS) {
  // Required lazily so a machine with no credentials doesn't pay the cost of
  // constructing a Storage client it will never use.
  const { Storage } = require('@google-cloud/storage');
  bucket = new Storage().bucket(GCS_BUCKET);
  console.log(`[files] using Cloud Storage bucket "${GCS_BUCKET}"`);
} else {
  console.log('[files] using local disk (data/uploads) — GCS_BUCKET not set.');
}

function ensureLocalDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Guards against a crafted key escaping the upload directory. Object keys are
// built server-side from uuids today, but this is cheap and the consequence
// of getting it wrong is arbitrary file read.
function resolveLocalPath(objectKey) {
  const full = path.resolve(LOCAL_UPLOAD_DIR, objectKey);
  if (!full.startsWith(path.resolve(LOCAL_UPLOAD_DIR) + path.sep)) {
    throw new Error('Invalid file path.');
  }
  return full;
}

// Uploads one buffered file under the given key prefix and returns the
// metadata stored on the Firestore/JSON document.
async function uploadBufferedFile(file, keyPrefix) {
  if (!file) return null;

  const ext = path.extname(file.originalname).toLowerCase();
  const objectKey = `${keyPrefix}/${uuidv4()}${ext}`;

  if (USE_GCS) {
    await bucket.file(objectKey).save(file.buffer, {
      contentType: file.mimetype,
      resumable: false,
    });
  } else {
    const full = resolveLocalPath(objectKey);
    ensureLocalDir(path.dirname(full));
    fs.writeFileSync(full, file.buffer);
  }

  return { fileName: file.originalname, storedFileName: objectKey, fileSize: file.size };
}

// Streams a stored file back as a download, 404-ing cleanly when it's missing
// rather than letting a stream error surface as a 500.
//
// downloadName is what the browser saves the file as -- callers serving
// anonymous review pass a neutral name, since original filenames routinely
// contain the author's surname.
function streamDownload(res, objectKey, downloadName, next) {
  if (!objectKey) {
    return res.status(404).json({ error: 'File not found.' });
  }

  if (USE_GCS) {
    res.attachment(downloadName);
    bucket
      .file(objectKey)
      .createReadStream()
      .on('error', (err) => {
        if (err.code === 404) {
          if (!res.headersSent) res.status(404).json({ error: 'File no longer available.' });
          else res.end();
          return;
        }
        next(err);
      })
      .pipe(res);
    return;
  }

  let full;
  try {
    full = resolveLocalPath(objectKey);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!fs.existsSync(full)) {
    return res.status(404).json({ error: 'File no longer available.' });
  }
  res.download(full, downloadName, (err) => {
    if (err && !res.headersSent) next(err);
  });
}

// Reads a stored object back into memory.
//
// Needed by the public article page, which renders a generated HTML galley
// inline rather than serving it as a download. Returns null when the object
// is gone, because a missing galley must degrade to "no full text here"
// rather than a 500 on a public page.
async function readStoredFile(objectKey) {
  if (!objectKey) return null;
  try {
    if (USE_GCS) {
      const [buf] = await bucket.file(objectKey).download();
      return buf;
    }
    const full = resolveLocalPath(objectKey);
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full);
  } catch (err) {
    if (err && (err.code === 404 || err.code === 'ENOENT')) return null;
    console.error('[files] could not read stored file:', err && err.message);
    return null;
  }
}

// Deletes a stored object. Failures are logged and swallowed: an editor
// removing a mistaken upload cares that it disappears from the workflow, and
// a storage object that outlives its record is untidy, not harmful.
async function deleteStoredFile(objectKey) {
  if (!objectKey) return false;
  try {
    if (USE_GCS) {
      await bucket.file(objectKey).delete({ ignoreNotFound: true });
      return true;
    }
    const full = resolveLocalPath(objectKey);
    if (fs.existsSync(full)) fs.unlinkSync(full);
    return true;
  } catch (err) {
    console.error('[files] could not delete stored file:', err && err.message);
    return false;
  }
}

// Stores a buffer we generated ourselves (rather than one a user uploaded).
// Same return shape as uploadBufferedFile so the two are interchangeable
// wherever a stored file is recorded.
async function storeGeneratedFile({ buffer, fileName, contentType }, keyPrefix) {
  const fake = {
    originalname: fileName,
    buffer,
    mimetype: contentType || 'application/octet-stream',
    size: buffer.length,
  };
  return uploadBufferedFile(fake, keyPrefix);
}

// Strips an author's name out of a filename for anonymous review, keeping
// only the extension. "Sharma-et-al-final.docx" -> "manuscript-round-1.docx"
function anonymousFileName(originalName, label) {
  const ext = path.extname(String(originalName || '')).toLowerCase() || '.pdf';
  return `${label}${ext}`;
}

module.exports = {
  usingCloudStorage: USE_GCS,
  bucket,
  ALLOWED_EXT,
  MAX_FILE_BYTES,
  MAX_SUPPLEMENTARY,
  uploadBufferedFile,
  streamDownload,
  anonymousFileName,
  readStoredFile,
  deleteStoredFile,
  storeGeneratedFile,
};
