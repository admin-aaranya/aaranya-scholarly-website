// The author's pre-submission manuscript assistant.
//
// AUTHORS ONLY. There is deliberately no editor or reviewer route into this
// module, and that is a design decision rather than an omission. Peer review
// at this publisher is a human judgement; if an editor could run a manuscript
// through a model and read the output, that output would start influencing
// decisions no matter how it was labelled. Keeping the feature on the
// author's side of the wall is the only version of it that is safe to ship.
//
// Everything here is advisory. The check is optional, its result is never
// stored against the submission, and a failure of any kind returns a message
// rather than obstructing the author -- if the assistant is down, people must
// still be able to submit papers.

const express = require('express');
const path = require('path');
const multer = require('multer');

const { findUserById, updateUser } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { JOURNALS } = require('./auth');
const { AI_CHECKS_PER_DAY } = require('../config');
const gemini = require('../lib/gemini');
const { extractDocxText } = require('../lib/docx-text');
const check = require('../lib/manuscript-check');

const router = express.Router();

// Smaller than the 25 MB submission limit. A manuscript large enough to
// exceed this is nearly always a PDF full of high-resolution images, where
// the text the assistant needs is a fraction of the bytes -- and sending the
// images anyway is pure cost.
const MAX_CHECK_BYTES = 8 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CHECK_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.pdf', '.docx', '.doc'].includes(ext)) {
      return cb(new Error('Please upload a PDF or Word (.docx) file.'));
    }
    cb(null, true);
  },
});

// ---- Quota ----
//
// Held on the user record rather than in memory, because Cloud Run runs
// several instances and an in-memory counter would let an author get
// AI_CHECKS_PER_DAY per instance. Rolling 24 hours, not calendar days, so
// there is no midnight cliff for authors to queue against.
function recentChecks(user) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return (user.aiCheckTimes || []).filter((t) => new Date(t).getTime() > cutoff);
}

async function recordCheck(user) {
  const times = recentChecks(user).concat(new Date().toISOString());
  await updateUser(user.id, { aiCheckTimes: times });
  return times.length;
}

// Lets the submission page decide whether to render the panel at all. A
// disabled feature should be invisible, not a button that always fails.
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const user = await findUserById(req.user.id);
    const used = user ? recentChecks(user).length : 0;
    res.json({
      available: gemini.isAvailable(),
      checksUsed: used,
      checksPerDay: AI_CHECKS_PER_DAY,
      maxFileBytes: MAX_CHECK_BYTES,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/check', requireAuth, (req, res, next) => {
  upload.single('manuscript')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const tooBig = uploadErr.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({
        error: tooBig
          ? `That file is larger than ${Math.round(MAX_CHECK_BYTES / 1024 / 1024)} MB. ` +
            'You can still submit it — the assistant just cannot read files this large.'
          : uploadErr.message || 'Upload failed.',
      });
    }

    try {
      if (!gemini.isAvailable()) {
        return res.status(503).json({ error: 'The assistant is not available right now.' });
      }

      // Consent is required every time, not remembered. The author is sending
      // unpublished work to a third-party service and should be choosing that
      // deliberately on each occasion, not once at registration.
      if (String(req.body && req.body.consent) !== 'true') {
        return res.status(400).json({
          error: 'Please tick the consent box before running the check.',
        });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'Please attach your manuscript first.' });
      }

      const user = await findUserById(req.user.id);
      if (!user) return res.status(401).json({ error: 'Please sign in again.' });

      const used = recentChecks(user).length;
      if (used >= AI_CHECKS_PER_DAY) {
        return res.status(429).json({
          error:
            `You have used all ${AI_CHECKS_PER_DAY} assistant checks for today. ` +
            'This limit resets 24 hours after your earliest check. You can still submit ' +
            'your manuscript as normal.',
        });
      }

      const body = req.body || {};
      const journalName = JOURNALS[body.journalCode] || '';

      // Build the content parts. PDFs go to Gemini as bytes -- it reads the
      // document directly, including tables and figure captions, which is
      // better than any text extraction we could do. Word files have no
      // native input type, so those we extract (see lib/docx-text.js).
      const ext = path.extname(req.file.originalname).toLowerCase();
      const parts = [
        {
          text: check.userPrompt({
            articleType: body.articleType,
            journalName,
            title: body.title,
            abstract: body.abstract,
            keywords: body.keywords,
          }),
        },
      ];

      if (ext === '.pdf') {
        parts.push({
          inlineData: {
            mimeType: 'application/pdf',
            data: req.file.buffer.toString('base64'),
          },
        });
      } else {
        let text;
        try {
          text = extractDocxText(req.file.buffer);
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
        const truncated = text.length > gemini.MAX_TEXT_CHARS;
        parts.push({
          text:
            '--- MANUSCRIPT TEXT ---\n' +
            text.slice(0, gemini.MAX_TEXT_CHARS) +
            (truncated ? '\n\n[Manuscript truncated at this point for length.]' : ''),
        });
      }

      // Count the attempt before making it. Charging the quota on failure is
      // slightly unfair to the author, but the alternative lets a client
      // trigger unlimited billed calls by aborting each one.
      await recordCheck(user);

      let result;
      try {
        result = await gemini.generateJson({
          parts,
          systemInstruction: check.systemInstruction(),
          schema: check.RESPONSE_SCHEMA,
        });
      } catch (err) {
        console.error('[assistant] check failed:', err && err.message);
        return res.status(502).json({
          error:
            'The assistant could not read your manuscript this time. ' +
            'This does not affect your submission — please carry on.',
        });
      }

      res.json({
        report: check.normalise(result.data),
        checksUsed: used + 1,
        checksPerDay: AI_CHECKS_PER_DAY,
      });
    } catch (err) {
      next(err);
    }
  });
});

module.exports = router;
module.exports.MAX_CHECK_BYTES = MAX_CHECK_BYTES;
module.exports.recentChecks = recentChecks;
