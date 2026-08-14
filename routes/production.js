// Copyediting, production and issue assembly. Editor-only, like
// routes/editorial.js -- split out because that file already carries the
// whole peer-review stage and this is a second workflow of comparable size.
//
// Three things live here:
//
//   1. Stage file rounds -- the copyedited drafts, author responses and
//      proofs exchanged after acceptance.
//   2. Galleys -- the reader-facing renditions (uploaded PDF, or full-text
//      HTML generated from the accepted Word file).
//   3. Issues -- the volume/number containers articles are published into,
//      and the article-level publication metadata (pages, DOI, licence).
//
// The public read path for all of this is routes/public.js, which shares no
// code with this file on purpose: everything here assumes an authenticated
// editor, and nothing here should ever be one refactor away from serving an
// unpublished manuscript to the internet.

const express = require('express');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const {
  getSubmissionById,
  updateSubmission,
  createIssue,
  getIssueById,
  updateIssue,
  getIssues,
  deleteIssue,
  getSubmissionsByIssue,
} = require('../db');
const { requireAuth } = require('../middleware/auth');
const {
  requireEditor,
  myJournals,
  mayEdit,
  loadInScope,
  withWorkflowDefaults,
} = require('../lib/editor-scope');
const {
  MAX_FILE_BYTES,
  uploadBufferedFile,
  storeGeneratedFile,
  streamDownload,
  readStoredFile,
  deleteStoredFile,
} = require('../lib/files');
const {
  STAGES,
  FILE_KINDS_BY_KEY,
  fileKindsForStage,
  canUploadFile,
  GALLEY_FORMATS,
  GALLEY_SOURCES,
  galleyFormatForExtension,
  sortGalleys,
  publishBlockers,
} = require('../lib/workflow');
const {
  ISSUE_STATUS,
  validateIssue,
  findIssueClash,
  issueLabel,
  sortIssues,
  sortArticlesInIssue,
} = require('../lib/issues');
const {
  LICENCES,
  DEFAULT_LICENCE,
  suggestPages,
  nextStartPage,
  pageOverlaps,
  nextArticleOrder,
  duplicateOrder,
  generateDoi,
  normaliseDoi,
} = require('../lib/publication');
const { pdfPageCount } = require('../lib/pdf-pages');
const { JOURNALS, JOURNAL_CODES } = require('../lib/journals');
const { generateHtmlGalley } = require('../lib/galley');
const notifications = require('../lib/notifications');
const { SITE_URL, DOI_PREFIX } = require('../config');

const router = express.Router();

router.use(requireAuth, requireEditor);

// ---- Uploads ----
//
// Two separate multer instances with two separate allow-lists, because the
// two things being uploaded have genuinely different risk. A workflow file is
// a manuscript (PDF or Word). A galley is something a reader will open, which
// additionally allows HTML and XML -- and those are only ever served back as
// downloads. See routes/public.js for the other half of that rule.

const WORKFLOW_EXT = new Set(['.pdf', '.doc', '.docx']);
const GALLEY_EXT = new Set(['.pdf', '.html', '.htm', '.xml']);

function makeUpload(allowed, message) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!allowed.has(ext)) return cb(new Error(message));
      cb(null, true);
    },
  });
}

const workflowUpload = makeUpload(
  WORKFLOW_EXT,
  'Workflow files must be PDF or Word documents (.pdf, .doc, .docx).'
).single('file');

const galleyUpload = makeUpload(
  GALLEY_EXT,
  'A galley must be a PDF, HTML or XML file (.pdf, .html, .xml).'
).single('file');

// multer reports its own errors through a callback rather than next(), so
// each upload route wraps it once here instead of repeating the dance.
function withUpload(handler, uploader) {
  return (req, res, next) => {
    uploader(req, res, (err) => {
      if (err) {
        const tooBig = err.code === 'LIMIT_FILE_SIZE';
        return res.status(400).json({
          error: tooBig
            ? `That file is larger than ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB.`
            : err.message || 'File upload failed.',
        });
      }
      handler(req, res, next).catch(next);
    });
  };
}

function editorLabel(user) {
  return user && user.name ? user.name : 'Editorial office';
}

// ============================================================================
// Stage files -- the copyediting and production rounds
// ============================================================================

// What this editor may upload right now, so the UI offers exactly the kinds
// the server would accept rather than a list it then rejects.
router.get('/submissions/:id/files', async (req, res, next) => {
  try {
    const inScope = await loadInScope(req, res, req.params.id);
    if (!inScope) return;
    const submission = withWorkflowDefaults(inScope);

    const files = (submission.stageFiles || []).map((f) => ({
      id: f.id,
      kind: f.kind,
      kindLabel: (FILE_KINDS_BY_KEY[f.kind] || {}).label || f.kind,
      authorVisible: Boolean((FILE_KINDS_BY_KEY[f.kind] || {}).authorVisible),
      stage: f.stage,
      round: f.round,
      fileName: f.file ? f.file.fileName : '',
      fileSize: f.file ? f.file.fileSize : 0,
      note: f.note || '',
      uploadedByRole: f.uploadedByRole,
      uploadedByName: f.uploadedByName || '',
      uploadedAt: f.uploadedAt,
      needsAuthorAction: Boolean(f.needsAuthorAction),
      answeredAt: f.answeredAt || '',
    }));

    res.json({
      files,
      stage: submission.stage,
      // Nothing is uploadable outside copyediting and production; an empty
      // list is how the UI knows to say so.
      uploadableKinds: fileKindsForStage(submission.stage, 'editor')
        .filter((k) => canUploadFile(submission.stage, k.key, 'editor'))
        .map((k) => ({ key: k.key, label: k.label, hint: k.hint, authorVisible: k.authorVisible })),
      // Copyediting kinds stay available in production -- see canUploadFile.
      alsoUploadable:
        submission.stage === STAGES.PRODUCTION
          ? fileKindsForStage(STAGES.COPYEDITING, 'editor').map((k) => ({
              key: k.key,
              label: k.label,
              hint: k.hint,
              authorVisible: k.authorVisible,
            }))
          : [],
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/submissions/:id/files',
  withUpload(async (req, res) => {
    const inScope = await loadInScope(req, res, req.params.id);
    if (!inScope) return;
    const submission = withWorkflowDefaults(inScope);

    const kindKey = String((req.body || {}).kind || '');
    const kind = FILE_KINDS_BY_KEY[kindKey];
    if (!kind) {
      return res.status(400).json({ error: 'Unknown file type.' });
    }
    if (!canUploadFile(submission.stage, kindKey, 'editor')) {
      return res.status(409).json({
        error: `"${kind.label}" cannot be added while the manuscript is at the ${submission.stage} stage.`,
      });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Choose a file to upload.' });
    }

    const stored = await uploadBufferedFile(req.file, `submissions/${submission.id}/${kind.stage}`);
    const now = new Date().toISOString();
    const entry = {
      id: uuidv4(),
      kind: kind.key,
      stage: kind.stage,
      round: (submission.stageFiles || []).filter((f) => f.kind === kind.key).length + 1,
      file: stored,
      note: String((req.body || {}).note || '').trim(),
      uploadedById: req.user.id,
      uploadedByName: editorLabel(req.user),
      uploadedByRole: 'editor',
      uploadedAt: now,
      // Only meaningful on kinds the author can see; asking an author to act
      // on a file they cannot open would be a dead end.
      needsAuthorAction:
        kind.authorVisible && String((req.body || {}).needsAuthorAction || '') === 'true',
      answeredAt: '',
    };

    const updated = await updateSubmission(submission.id, {
      stageFiles: (submission.stageFiles || []).concat(entry),
    });
    res.status(201).json({ file: entry, stageFiles: (updated && updated.stageFiles) || [] });

    if (entry.needsAuthorAction) {
      notifications
        .copyeditingFileShared({ submission: updated || submission, entry })
        .catch((e) => console.error('[production] file notification failed:', e && e.message));
    }
  }, workflowUpload)
);

router.get('/submissions/:id/files/:fileId', async (req, res, next) => {
  try {
    const inScope = await loadInScope(req, res, req.params.id);
    if (!inScope) return;
    const entry = (inScope.stageFiles || []).find((f) => f.id === req.params.fileId);
    if (!entry || !entry.file) {
      return res.status(404).json({ error: 'File not found.' });
    }
    streamDownload(res, entry.file.storedFileName, entry.file.fileName, next);
  } catch (err) {
    next(err);
  }
});

// Removes a mistaken upload. The stored object is deleted too -- unlike a
// review invitation, a wrong file in the workflow has no evidentiary value
// worth keeping, and leaving it in the bucket means it is still one signed
// URL away from being readable.
router.delete('/submissions/:id/files/:fileId', async (req, res, next) => {
  try {
    const inScope = await loadInScope(req, res, req.params.id);
    if (!inScope) return;
    const files = inScope.stageFiles || [];
    const entry = files.find((f) => f.id === req.params.fileId);
    if (!entry) {
      return res.status(404).json({ error: 'File not found.' });
    }
    // An author's own upload is their record of what they sent. An editor
    // deleting it would leave the author looking at a workflow that no longer
    // shows their response.
    if (entry.uploadedByRole === 'author') {
      return res.status(409).json({
        error: "This file was uploaded by the author and cannot be removed from the editorial side.",
      });
    }

    const remaining = files.filter((f) => f.id !== entry.id);
    await updateSubmission(inScope.id, { stageFiles: remaining });
    res.json({ removed: entry.id, stageFiles: remaining });

    if (entry.file) await deleteStoredFile(entry.file.storedFileName);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Galleys
// ============================================================================

function galleySummary(g) {
  return {
    id: g.id,
    label: g.label,
    format: g.format,
    formatLabel: (GALLEY_FORMATS[g.format] || {}).label || g.format,
    source: g.source,
    fileName: g.file ? g.file.fileName : '',
    fileSize: g.file ? g.file.fileSize : 0,
    order: g.order,
    stats: g.stats || null,
    createdAt: g.createdAt,
    createdByName: g.createdByName || '',
  };
}

router.get('/submissions/:id/galleys', async (req, res, next) => {
  try {
    const inScope = await loadInScope(req, res, req.params.id);
    if (!inScope) return;
    const submission = withWorkflowDefaults(inScope);
    res.json({
      galleys: sortGalleys(submission.galleys || []).map(galleySummary),
      formats: Object.values(GALLEY_FORMATS).map((f) => ({ key: f.key, label: f.label })),
      // Candidate sources for HTML generation: any .docx already in the
      // workflow. Offering the editor a file picker they have to guess at is
      // how the wrong version gets published.
      generateSources: generationSources(submission),
    });
  } catch (err) {
    next(err);
  }
});

// Every .docx on the record, newest first, described well enough for an
// editor to tell them apart.
function generationSources(submission) {
  const out = [];
  const isDocx = (f) => f && /\.docx$/i.test(String(f.fileName || ''));

  (submission.stageFiles || []).forEach((f) => {
    if (!isDocx(f.file)) return;
    out.push({
      ref: `stage:${f.id}`,
      label: `${(FILE_KINDS_BY_KEY[f.kind] || {}).label || f.kind} — ${f.file.fileName}`,
      uploadedAt: f.uploadedAt,
    });
  });

  (submission.revisions || []).forEach((r, i) => {
    if (!isDocx(r.file)) return;
    out.push({
      ref: `revision:${i}`,
      label: `Author revision, round ${r.round} — ${r.file.fileName}`,
      uploadedAt: r.uploadedAt,
    });
  });

  if (isDocx(submission.manuscript)) {
    out.push({
      ref: 'manuscript',
      label: `Original manuscript — ${submission.manuscript.fileName}`,
      uploadedAt: submission.submittedAt,
    });
  }

  return out.sort((a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0));
}

// Resolves a `generateSources` ref back to a stored file. Returns null for
// anything unrecognised rather than throwing, so a stale ref from an open
// browser tab is a clean 400.
function resolveSourceRef(submission, ref) {
  const raw = String(ref || '');
  if (raw === 'manuscript') return submission.manuscript || null;
  const [kind, key] = raw.split(':');
  if (kind === 'stage') {
    const entry = (submission.stageFiles || []).find((f) => f.id === key);
    return entry ? entry.file : null;
  }
  if (kind === 'revision') {
    const rev = (submission.revisions || [])[parseInt(key, 10)];
    return rev ? rev.file : null;
  }
  return null;
}

function nextGalleyOrder(galleys) {
  const orders = (galleys || []).map((g) => (Number.isFinite(g.order) ? g.order : 0));
  return orders.length ? Math.max.apply(null, orders) + 1 : 1;
}

// Galleys may only be built in production (or afterwards, for a correction to
// something already published). Before that the text is still moving.
function galleyStageAllowed(stage) {
  return stage === STAGES.PRODUCTION || stage === STAGES.PUBLISHED;
}

router.post(
  '/submissions/:id/galleys',
  withUpload(async (req, res) => {
    const inScope = await loadInScope(req, res, req.params.id);
    if (!inScope) return;
    const submission = withWorkflowDefaults(inScope);

    if (!galleyStageAllowed(submission.stage)) {
      return res.status(409).json({
        error: 'Galleys can only be added once the article reaches Production.',
      });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Choose a galley file to upload.' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const detected = galleyFormatForExtension(ext);
    const requested = String((req.body || {}).format || '').toLowerCase();
    const format = GALLEY_FORMATS[requested] ? requested : detected;
    if (!format) {
      return res.status(400).json({ error: 'Unsupported galley format.' });
    }
    // A .pdf labelled "HTML" would be served with the wrong disposition and
    // read as the wrong thing. The extension is the fact; the dropdown is a
    // preference.
    if (detected && format !== detected) {
      return res.status(400).json({
        error: `That file looks like ${GALLEY_FORMATS[detected].label}, not ${GALLEY_FORMATS[format].label}. Choose the matching format.`,
      });
    }

    const stored = await uploadBufferedFile(req.file, `submissions/${submission.id}/galleys`);
    const galley = {
      id: uuidv4(),
      label: String((req.body || {}).label || '').trim() || GALLEY_FORMATS[format].label,
      format,
      source: GALLEY_SOURCES.UPLOADED,
      file: stored,
      order: nextGalleyOrder(submission.galleys),
      createdAt: new Date().toISOString(),
      createdById: req.user.id,
      createdByName: editorLabel(req.user),
    };

    const galleys = (submission.galleys || []).concat(galley);
    await updateSubmission(submission.id, { galleys });
    res.status(201).json({ galley: galleySummary(galley), galleys: sortGalleys(galleys).map(galleySummary) });
  }, galleyUpload)
);

// Builds a full-text HTML galley from a .docx already in the workflow.
//
// The output is stored as an HTML fragment, not a whole document, because the
// public article page renders it inside our own template -- which is what
// makes the full text crawlable and styled like the rest of the site instead
// of being a bare download.
router.post('/submissions/:id/galleys/generate', async (req, res, next) => {
  try {
    const inScope = await loadInScope(req, res, req.params.id);
    if (!inScope) return;
    const submission = withWorkflowDefaults(inScope);

    if (!galleyStageAllowed(submission.stage)) {
      return res.status(409).json({
        error: 'Galleys can only be added once the article reaches Production.',
      });
    }

    const sourceFile = resolveSourceRef(submission, (req.body || {}).source);
    if (!sourceFile) {
      return res.status(400).json({ error: 'Choose which file to build the full text from.' });
    }

    const buffer = await readStoredFile(sourceFile.storedFileName);
    if (!buffer) {
      return res.status(404).json({ error: 'That file is no longer in storage.' });
    }

    let built;
    try {
      built = generateHtmlGalley({
        buffer,
        fileName: sourceFile.fileName,
        article: { title: submission.title },
      });
    } catch (err) {
      // These messages are written for editors and say what to do next.
      return res.status(422).json({ error: err.message });
    }

    const stored = await storeGeneratedFile(
      {
        buffer: Buffer.from(built.html, 'utf8'),
        fileName: `${submission.id}-fulltext.html`,
        contentType: 'text/html; charset=utf-8',
      },
      `submissions/${submission.id}/galleys`
    );

    // Regenerating replaces the previous generated HTML rather than stacking
    // a second full text next to the first -- two "HTML" links on an article
    // page is a reader's problem, not a version history.
    const previous = (submission.galleys || []).find(
      (g) => g.source === GALLEY_SOURCES.GENERATED && g.format === 'html'
    );
    const galley = {
      id: previous ? previous.id : uuidv4(),
      label: previous ? previous.label : 'Full text (HTML)',
      format: 'html',
      source: GALLEY_SOURCES.GENERATED,
      file: stored,
      order: previous && Number.isFinite(previous.order) ? previous.order : nextGalleyOrder(submission.galleys),
      createdAt: new Date().toISOString(),
      createdById: req.user.id,
      createdByName: editorLabel(req.user),
      sourceFileName: sourceFile.fileName,
      stats: built.stats,
    };

    const galleys = (submission.galleys || [])
      .filter((g) => g.id !== galley.id)
      .concat(galley);
    await updateSubmission(submission.id, { galleys });

    res.status(201).json({
      galley: galleySummary(galley),
      galleys: sortGalleys(galleys).map(galleySummary),
      replaced: Boolean(previous),
    });

    if (previous && previous.file && previous.file.storedFileName !== stored.storedFileName) {
      await deleteStoredFile(previous.file.storedFileName);
    }
  } catch (err) {
    next(err);
  }
});

router.patch('/submissions/:id/galleys/:galleyId', async (req, res, next) => {
  try {
    const inScope = await loadInScope(req, res, req.params.id);
    if (!inScope) return;
    const submission = withWorkflowDefaults(inScope);
    const galleys = (submission.galleys || []).slice();
    const idx = galleys.findIndex((g) => g.id === req.params.galleyId);
    if (idx === -1) {
      return res.status(404).json({ error: 'Galley not found.' });
    }

    const body = req.body || {};
    const patch = {};
    if (typeof body.label === 'string') {
      const label = body.label.trim();
      if (!label) return res.status(400).json({ error: 'A galley needs a label.' });
      patch.label = label;
    }
    if (body.order !== undefined) {
      const order = Number(body.order);
      if (!Number.isFinite(order)) return res.status(400).json({ error: 'Order must be a number.' });
      patch.order = order;
    }

    galleys[idx] = Object.assign({}, galleys[idx], patch);
    await updateSubmission(submission.id, { galleys });
    res.json({ galleys: sortGalleys(galleys).map(galleySummary) });
  } catch (err) {
    next(err);
  }
});

router.delete('/submissions/:id/galleys/:galleyId', async (req, res, next) => {
  try {
    const inScope = await loadInScope(req, res, req.params.id);
    if (!inScope) return;
    const submission = withWorkflowDefaults(inScope);
    const galley = (submission.galleys || []).find((g) => g.id === req.params.galleyId);
    if (!galley) {
      return res.status(404).json({ error: 'Galley not found.' });
    }

    const remaining = (submission.galleys || []).filter((g) => g.id !== galley.id);
    // Removing the last galley from a live article would leave a public page
    // with nothing to read on it. Withdraw the article or replace the galley
    // first -- both are deliberate acts, which is the point.
    if (submission.stage === STAGES.PUBLISHED && !remaining.length) {
      return res.status(409).json({
        error:
          'This is the only galley on a published article. Add its replacement first, or the article page would have nothing to open.',
      });
    }

    await updateSubmission(submission.id, { galleys: remaining });
    res.json({ removed: galley.id, galleys: sortGalleys(remaining).map(galleySummary) });

    if (galley.file) await deleteStoredFile(galley.file.storedFileName);
  } catch (err) {
    next(err);
  }
});

// Editor preview. Always a download, never inline -- an uploaded galley is a
// third party's file, and rendering it on our origin would hand it the
// editor's session. The public route applies the same rule for the same
// reason.
router.get('/submissions/:id/galleys/:galleyId/file', async (req, res, next) => {
  try {
    const inScope = await loadInScope(req, res, req.params.id);
    if (!inScope) return;
    const galley = (inScope.galleys || []).find((g) => g.id === req.params.galleyId);
    if (!galley || !galley.file) {
      return res.status(404).json({ error: 'Galley not found.' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    streamDownload(res, galley.file.storedFileName, galley.file.fileName, next);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Publication metadata
// ============================================================================

// How long is this article, in printed pages?
//
// Only the PDF galley can answer, because only the PDF is paginated -- HTML
// full text has no pages at all. Where there are several PDFs (a corrected
// version alongside the original) the first in galley order wins, which is the
// one the reader is offered first.
//
// Returns null for "cannot tell", never a guess. Callers must treat null as
// "ask the editor", because a wrong page range ends up inside citations that
// other people have already made and cannot be corrected afterwards.
async function pdfLengthOf(submission) {
  const pdfs = sortGalleys(submission.galleys || []).filter(
    (g) => g.format === 'pdf' && g.file && g.file.objectKey
  );
  if (!pdfs.length) return null;
  try {
    const buffer = await readStoredFile(pdfs[0].file.objectKey);
    return pdfPageCount(buffer);
  } catch (err) {
    // A storage hiccup must not stop an editor publishing -- they can always
    // type the range themselves. Degrade to manual, quietly.
    return null;
  }
}

// Everything the publication panel can work out on the editor's behalf, plus
// the reasons it cannot where it cannot.
//
// This is a READ. It computes and returns; it never writes. The editor sees
// each suggestion and accepts it explicitly.
async function publicationSuggestions(submission, issue) {
  const out = {
    pages: '',
    pagesReason: '',
    articleOrder: null,
    doi: '',
    doiReason: '',
    licence: submission.license || DEFAULT_LICENCE,
    warnings: [],
    pdfPageCount: null,
  };

  if (!issue) {
    out.pagesReason = 'Assign the article to an issue first — pages run continuously through an issue, so there is nothing to count from until then.';
    out.doiReason = 'Assign the article to an issue first.';
    return out;
  }

  const siblings = await getSubmissionsByIssue(issue.id);
  const others = (siblings || []).filter((a) => a.id !== submission.id);

  out.articleOrder = nextArticleOrder(siblings, submission.id);

  const pageCount = await pdfLengthOf(submission);
  out.pdfPageCount = pageCount;
  const startsAt = nextStartPage(siblings, submission.id);

  if (pageCount) {
    out.pages = suggestPages(siblings, submission.id, pageCount);
  } else {
    const hasPdf = (submission.galleys || []).some((g) => g.format === 'pdf');
    out.pagesReason = hasPdf
      ? `The PDF's length could not be read, so the range has to be typed. The next free page in this issue is ${startsAt}.`
      : `Upload the PDF galley and the range fills itself in. The next free page in this issue is ${startsAt}.`;
  }

  const order = Number.isFinite(Number(submission.articleOrder))
    ? Number(submission.articleOrder)
    : out.articleOrder;

  if (DOI_PREFIX) {
    out.doi = generateDoi({
      prefix: DOI_PREFIX,
      journalCode: submission.journalCode,
      year: issue.year,
      volume: issue.volume,
      number: issue.number,
      articleOrder: order,
    });
  } else {
    out.doiReason =
      'No Crossref prefix is configured, so no DOI is offered. A generated DOI would be well-formed but would resolve to nothing — worse than leaving it blank, because authors cite it. Set DOI_PREFIX once membership is in place.';
  }

  const clashingOrder = duplicateOrder(siblings, submission.id, submission.articleOrder);
  if (clashingOrder.length) {
    out.warnings.push(
      `Position ${submission.articleOrder} in this issue is also taken by "${clashingOrder[0].title}".`
    );
  }
  const clashingPages = pageOverlaps(others, submission.id, submission.pages);
  if (clashingPages.length) {
    out.warnings.push(
      `Pages ${submission.pages} overlap "${clashingPages[0].title}" (${clashingPages[0].pages}).`
    );
  }

  return out;
}

// Read-only. The panel calls this whenever the issue changes, so the editor
// sees what the system would fill in before anything is saved.
router.get('/submissions/:id/publication/suggestions', async (req, res, next) => {
  try {
    const inScope = await loadInScope(req, res, req.params.id);
    if (!inScope) return;
    const submission = withWorkflowDefaults(inScope);
    // ?issueId= lets the panel preview a DIFFERENT issue to the saved one,
    // which is what the editor is looking at the moment they change the
    // dropdown but before they save.
    const wantedId = String(req.query.issueId || submission.issueId || '').trim();
    const issue = wantedId ? await getIssueById(wantedId) : null;
    const usable = issue && issue.journalCode === submission.journalCode ? issue : null;

    res.json({
      suggestions: await publicationSuggestions(submission, usable),
      licences: LICENCES,
      defaultLicence: DEFAULT_LICENCE,
      doiPrefixConfigured: Boolean(DOI_PREFIX),
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/submissions/:id/publication', async (req, res, next) => {
  try {
    const inScope = await loadInScope(req, res, req.params.id);
    if (!inScope) return;
    const submission = withWorkflowDefaults(inScope);
    const body = req.body || {};
    const patch = {};

    if (body.issueId !== undefined) {
      const issueId = String(body.issueId || '').trim();
      if (issueId) {
        const issue = await getIssueById(issueId);
        if (!issue) return res.status(400).json({ error: 'That issue no longer exists.' });
        // An article belongs to its own journal's issue or to none. Without
        // this a management paper can be filed into a life-sciences volume,
        // and the citation it generates is simply wrong.
        if (issue.journalCode !== submission.journalCode) {
          return res.status(400).json({
            error: `That issue belongs to ${JOURNALS[issue.journalCode] || issue.journalCode}, not ${submission.journalName}.`,
          });
        }
        if (!mayEdit(req, issue.journalCode)) {
          return res.status(403).json({ error: 'You do not cover that journal.' });
        }
      }
      patch.issueId = issueId;
    }

    if (body.pages !== undefined) patch.pages = String(body.pages || '').trim();
    if (body.license !== undefined) patch.license = String(body.license || '').trim();
    // Stored bare (10.xxxx/yyyy) -- see lib/publication.js on why.
    if (body.doi !== undefined) patch.doi = normaliseDoi(body.doi);
    if (body.articleOrder !== undefined) {
      const order = Number(body.articleOrder);
      patch.articleOrder = Number.isFinite(order) ? order : null;
    }

    const merged0 = withWorkflowDefaults(Object.assign({}, submission, patch));
    const issue = merged0.issueId ? await getIssueById(merged0.issueId) : null;

    // Fill the blanks, and ONLY the blanks.
    //
    // The editor's own value always wins -- an issue that paginates with
    // section prefixes, or a running order set deliberately out of sequence,
    // must survive the next save of an unrelated field. So these apply when
    // the field is empty, never as a correction to something already there.
    if (issue) {
      const siblings = await getSubmissionsByIssue(issue.id);

      if (!String(merged0.articleOrder ?? '').trim() && merged0.articleOrder !== 0) {
        patch.articleOrder = nextArticleOrder(siblings, submission.id);
      }

      if (!String(merged0.pages || '').trim()) {
        const pageCount = await pdfLengthOf(merged0);
        const suggested = suggestPages(siblings, submission.id, pageCount);
        if (suggested) patch.pages = suggested;
      }

      // Defaulted only when the editor has never expressed a view. If they
      // have just chosen "— not set —" that is a decision, and putting the
      // default back would make the field impossible to clear.
      if (!String(merged0.license || '').trim() && body.license === undefined) {
        patch.license = DEFAULT_LICENCE;
      }

      if (!String(merged0.doi || '').trim() && DOI_PREFIX) {
        const order = Number.isFinite(Number(patch.articleOrder ?? merged0.articleOrder))
          ? Number(patch.articleOrder ?? merged0.articleOrder)
          : null;
        const doi = generateDoi({
          prefix: DOI_PREFIX,
          journalCode: merged0.journalCode,
          year: issue.year,
          volume: issue.volume,
          number: issue.number,
          articleOrder: order,
        });
        if (doi) patch.doi = doi;
      }
    }

    const updated = await updateSubmission(submission.id, patch);
    const merged = withWorkflowDefaults(updated || Object.assign({}, submission, patch));

    res.json({
      submission: {
        id: merged.id,
        issueId: merged.issueId || '',
        pages: merged.pages || '',
        doi: merged.doi || '',
        license: merged.license || '',
        articleOrder: merged.articleOrder,
      },
      issue: issue ? { id: issue.id, label: issueLabel(issue), status: issue.status } : null,
      suggestions: await publicationSuggestions(merged, issue),
      publishBlockers: publishBlockers(merged, merged.galleys || [], issue),
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Issues
// ============================================================================

function issueSummary(issue, articleCount) {
  return {
    id: issue.id,
    journalCode: issue.journalCode,
    journalName: JOURNALS[issue.journalCode] || issue.journalCode,
    volume: issue.volume,
    number: issue.number,
    year: issue.year,
    title: issue.title || '',
    description: issue.description || '',
    label: issueLabel(issue),
    status: issue.status,
    publishedAt: issue.publishedAt || '',
    createdAt: issue.createdAt,
    articleCount: articleCount === undefined ? undefined : articleCount,
  };
}

router.get('/issues', async (req, res, next) => {
  try {
    const mine = myJournals(req);
    const requested = String(req.query.journal || '').trim();
    if (requested && !mine.includes(requested)) {
      return res.status(403).json({ error: 'You do not cover that journal.' });
    }

    const all = await getIssues(requested || null);
    const scoped = all.filter((i) => mine.includes(i.journalCode));

    const counts = new Map();
    await Promise.all(
      scoped.map(async (i) => {
        counts.set(i.id, (await getSubmissionsByIssue(i.id)).length);
      })
    );

    res.json({
      issues: sortIssues(scoped).map((i) => issueSummary(i, counts.get(i.id))),
      journals: mine.reduce((acc, c) => {
        acc[c] = JOURNALS[c];
        return acc;
      }, {}),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/issues/:id', async (req, res, next) => {
  try {
    const issue = await getIssueById(req.params.id);
    if (!issue || !mayEdit(req, issue.journalCode)) {
      return res.status(404).json({ error: 'Issue not found.' });
    }
    const articles = await getSubmissionsByIssue(issue.id);
    res.json({
      issue: issueSummary(issue, articles.length),
      articles: sortArticlesInIssue(articles).map((a) => ({
        id: a.id,
        title: a.title,
        articleType: a.articleType,
        stage: a.stage,
        pages: a.pages || '',
        doi: a.doi || '',
        articleOrder: a.articleOrder,
        galleyCount: (a.galleys || []).length,
        publishedAt: a.publishedAt || '',
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/issues', async (req, res, next) => {
  try {
    const body = req.body || {};
    const check = validateIssue(body, JOURNAL_CODES);
    if (!check.ok) {
      return res.status(400).json({ error: check.errors[0], errors: check.errors });
    }
    if (!mayEdit(req, check.value.journalCode)) {
      return res.status(403).json({ error: 'You do not cover that journal.' });
    }

    const existing = await getIssues(check.value.journalCode);
    const clash = findIssueClash(existing, check.value, null);
    if (clash) {
      return res.status(409).json({
        error: `${issueLabel(clash)} already exists for this journal.`,
      });
    }

    const issue = Object.assign({}, check.value, {
      id: uuidv4(),
      status: ISSUE_STATUS.PLANNED,
      publishedAt: '',
      createdAt: new Date().toISOString(),
      createdById: req.user.id,
    });
    await createIssue(issue);
    res.status(201).json({ issue: issueSummary(issue, 0) });
  } catch (err) {
    next(err);
  }
});

router.patch('/issues/:id', async (req, res, next) => {
  try {
    const issue = await getIssueById(req.params.id);
    if (!issue || !mayEdit(req, issue.journalCode)) {
      return res.status(404).json({ error: 'Issue not found.' });
    }

    const merged = Object.assign({}, issue, req.body || {}, { journalCode: issue.journalCode });
    const check = validateIssue(merged, JOURNAL_CODES);
    if (!check.ok) {
      return res.status(400).json({ error: check.errors[0], errors: check.errors });
    }

    const existing = await getIssues(issue.journalCode);
    const clash = findIssueClash(existing, check.value, issue.id);
    if (clash) {
      return res.status(409).json({ error: `${issueLabel(clash)} already exists for this journal.` });
    }

    const updated = await updateIssue(issue.id, check.value);
    res.json({ issue: issueSummary(updated || Object.assign({}, issue, check.value)) });
  } catch (err) {
    next(err);
  }
});

// Releasing an issue is what makes its published articles publicly visible.
// That single rule is enforced in routes/public.js; this is the switch it
// reads.
router.post('/issues/:id/status', async (req, res, next) => {
  try {
    const issue = await getIssueById(req.params.id);
    if (!issue || !mayEdit(req, issue.journalCode)) {
      return res.status(404).json({ error: 'Issue not found.' });
    }
    const wanted = String((req.body || {}).status || '');
    if (wanted !== ISSUE_STATUS.PLANNED && wanted !== ISSUE_STATUS.PUBLISHED) {
      return res.status(400).json({ error: 'Unknown issue status.' });
    }

    const articles = await getSubmissionsByIssue(issue.id);
    if (wanted === ISSUE_STATUS.PUBLISHED) {
      const live = articles.filter((a) => a.stage === STAGES.PUBLISHED);
      if (!live.length) {
        return res.status(409).json({
          error:
            'This issue has no published articles yet. Publish at least one article into it first, or releasing it puts an empty issue on the public site.',
        });
      }
    }

    const patch = {
      status: wanted,
      publishedAt:
        wanted === ISSUE_STATUS.PUBLISHED
          ? issue.publishedAt || new Date().toISOString()
          : issue.publishedAt || '',
    };
    const updated = await updateIssue(issue.id, patch);
    res.json({ issue: issueSummary(updated || Object.assign({}, issue, patch), articles.length) });

    // Releasing the issue is the moment the articles actually become
    // readable, so this is where authors are told -- not at the Publish
    // decision, which may happen weeks earlier while the issue is still
    // being assembled.
    const becamePublic = wanted === ISSUE_STATUS.PUBLISHED && issue.status !== ISSUE_STATUS.PUBLISHED;
    if (becamePublic) {
      const label = issueLabel(updated || issue);
      articles
        .filter((a) => a.stage === STAGES.PUBLISHED)
        .forEach((article) => {
          notifications
            .articlePublished({
              submission: article,
              issueLabel: label,
              articleUrl: `${SITE_URL}/article/${article.id}`,
            })
            .catch((e) => console.error('[production] publication email failed:', e && e.message));
        });
    }
  } catch (err) {
    next(err);
  }
});

router.delete('/issues/:id', async (req, res, next) => {
  try {
    const issue = await getIssueById(req.params.id);
    if (!issue || !mayEdit(req, issue.journalCode)) {
      return res.status(404).json({ error: 'Issue not found.' });
    }
    const articles = await getSubmissionsByIssue(issue.id);
    if (articles.length) {
      return res.status(409).json({
        error: `${articles.length} article(s) are assigned to this issue. Move them to another issue first.`,
      });
    }
    if (issue.status === ISSUE_STATUS.PUBLISHED) {
      return res.status(409).json({
        error: 'A released issue cannot be deleted. Set it back to planned first.',
      });
    }
    await deleteIssue(issue.id);
    res.json({ removed: issue.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
