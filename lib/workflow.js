// Editorial workflow model, closely following Open Journal Systems (OJS 3.x).
//
// OJS runs a submission through four stages -- Submission, Review,
// Copyediting, Production -- with the editor recording an explicit decision
// to move between them. All four are implemented here: Submission and Review
// carry the peer-review core, Copyediting carries file rounds between editor
// and author, and Production carries galleys and issue assignment.
//
// Reference: https://docs.pkp.sfu.ca/learning-ojs/en/editorial-workflow

// ---- Stages ----
const STAGES = {
  SUBMISSION: 'submission',
  REVIEW: 'review',
  COPYEDITING: 'copyediting',
  PRODUCTION: 'production',
  PUBLISHED: 'published',
  DECLINED: 'declined',
};

const STAGE_ORDER = [
  STAGES.SUBMISSION,
  STAGES.REVIEW,
  STAGES.COPYEDITING,
  STAGES.PRODUCTION,
  STAGES.PUBLISHED,
];

const STAGE_LABELS = {
  [STAGES.SUBMISSION]: 'Submission',
  [STAGES.REVIEW]: 'Peer Review',
  [STAGES.COPYEDITING]: 'Copyediting',
  [STAGES.PRODUCTION]: 'Production',
  [STAGES.PUBLISHED]: 'Published',
  [STAGES.DECLINED]: 'Declined',
};

// Terminal stages -- no further editor decisions are accepted.
const TERMINAL_STAGES = new Set([STAGES.PUBLISHED, STAGES.DECLINED]);

// ---- Editor decisions ----
// Each decision declares which stages it's legal from, the stage it moves the
// submission to, and the author-facing status text it sets.
const DECISIONS = {
  SEND_TO_REVIEW: {
    key: 'send_to_review',
    label: 'Send to Review',
    from: [STAGES.SUBMISSION],
    to: STAGES.REVIEW,
    status: 'Under Review',
    note: 'Submission passed initial editorial screening and entered peer review.',
    startsRound: true,
  },
  ACCEPT_SKIP_REVIEW: {
    key: 'accept_skip_review',
    label: 'Accept and Skip Review',
    from: [STAGES.SUBMISSION],
    to: STAGES.COPYEDITING,
    status: 'Accepted',
    note: 'Accepted by the editor without external peer review.',
  },
  REQUEST_REVISIONS: {
    key: 'request_revisions',
    label: 'Request Revisions',
    from: [STAGES.REVIEW],
    to: STAGES.REVIEW,
    status: 'Revisions Requested',
    note: 'Revisions requested; the manuscript stays with the current review round.',
    requestsRevisions: true,
  },
  RESUBMIT_FOR_REVIEW: {
    key: 'resubmit_for_review',
    label: 'Resubmit for Review',
    from: [STAGES.REVIEW],
    to: STAGES.REVIEW,
    status: 'Revisions Requested (New Review Round)',
    note: 'Major revisions requested; a new review round will follow resubmission.',
    requestsRevisions: true,
    startsRound: true,
  },
  ACCEPT: {
    key: 'accept',
    label: 'Accept Submission',
    from: [STAGES.REVIEW],
    to: STAGES.COPYEDITING,
    status: 'Accepted',
    note: 'Accepted for publication following peer review.',
  },
  SEND_TO_PRODUCTION: {
    key: 'send_to_production',
    label: 'Send to Production',
    from: [STAGES.COPYEDITING],
    to: STAGES.PRODUCTION,
    status: 'In Production',
    note: 'Copyediting complete; moved to production.',
  },
  PUBLISH: {
    key: 'publish',
    label: 'Publish',
    from: [STAGES.PRODUCTION],
    to: STAGES.PUBLISHED,
    status: 'Published',
    note: 'Published.',
  },
  DECLINE: {
    key: 'decline',
    label: 'Decline Submission',
    from: [STAGES.SUBMISSION, STAGES.REVIEW, STAGES.COPYEDITING],
    to: STAGES.DECLINED,
    status: 'Declined',
    note: 'Declined by the editor.',
  },
};

const DECISIONS_BY_KEY = Object.values(DECISIONS).reduce((acc, d) => {
  acc[d.key] = d;
  return acc;
}, {});

// Which decisions an editor may take right now, given the current stage.
function availableDecisions(stage) {
  return Object.values(DECISIONS).filter((d) => d.from.includes(stage));
}

function isDecisionAllowed(decisionKey, stage) {
  const d = DECISIONS_BY_KEY[decisionKey];
  return Boolean(d && d.from.includes(stage));
}

// ---- Copyediting and production file rounds ----
//
// After acceptance the manuscript stops being a single file and becomes a
// small conversation conducted in files: the editor sends a copyedited draft,
// the author answers it, the editor marks a version final, and production
// works from that. OJS models this as per-stage file lists with a
// participant-visibility flag; the same shape is used here.
//
// Every file kind declares three things, and all three are enforced
// server-side:
//
//   stage         -- which workflow stage the file belongs to
//   uploadableBy  -- 'editor' or 'author'
//   authorVisible -- whether the author can see it at all
//
// `authorVisible` is the load-bearing one. An editor needs somewhere to put
// a working file the author should not read yet, and the failure mode of
// getting this wrong is showing an author an internal draft. So visibility
// is a property of the KIND, not a per-upload checkbox an editor can
// mis-click.

const FILE_KINDS = {
  COPYEDIT_DRAFT: {
    key: 'copyedit_draft',
    label: 'Copyedited draft',
    stage: STAGES.COPYEDITING,
    uploadableBy: 'editor',
    authorVisible: true,
    hint: 'A copyedited version sent to the author for approval.',
  },
  COPYEDIT_INTERNAL: {
    key: 'copyedit_internal',
    label: 'Internal working file',
    stage: STAGES.COPYEDITING,
    uploadableBy: 'editor',
    authorVisible: false,
    hint: 'Editorial working copy. Never shown to the author.',
  },
  AUTHOR_RESPONSE: {
    key: 'author_response',
    label: 'Author response',
    stage: STAGES.COPYEDITING,
    uploadableBy: 'author',
    authorVisible: true,
    hint: "The author's answer to a copyedited draft.",
  },
  COPYEDIT_FINAL: {
    key: 'copyedit_final',
    label: 'Final copyedited manuscript',
    stage: STAGES.COPYEDITING,
    uploadableBy: 'editor',
    authorVisible: true,
    hint: 'The version production works from.',
  },
  PRODUCTION_READY: {
    key: 'production_ready',
    label: 'Production-ready file',
    stage: STAGES.PRODUCTION,
    uploadableBy: 'editor',
    authorVisible: false,
    hint: 'Typeset source used to build the galleys.',
  },
  PROOF: {
    key: 'proof',
    label: 'Proof for the author',
    stage: STAGES.PRODUCTION,
    uploadableBy: 'editor',
    authorVisible: true,
    hint: 'A typeset proof sent to the author to check.',
  },
  PROOF_CORRECTIONS: {
    key: 'proof_corrections',
    label: 'Author corrections to proof',
    stage: STAGES.PRODUCTION,
    uploadableBy: 'author',
    authorVisible: true,
    hint: "The author's corrections to a proof.",
  },
};

const FILE_KINDS_BY_KEY = Object.values(FILE_KINDS).reduce((acc, k) => {
  acc[k.key] = k;
  return acc;
}, {});

// Stages that hold file rounds at all. Uploading is refused everywhere else,
// which stops a copyedited draft appearing on a manuscript still out for
// review.
const FILE_ROUND_STAGES = new Set([STAGES.COPYEDITING, STAGES.PRODUCTION]);

function fileKindsForStage(stage, actor) {
  return Object.values(FILE_KINDS).filter(
    (k) => k.stage === stage && (!actor || k.uploadableBy === actor)
  );
}

// May `actor` ('editor' | 'author') upload a file of this kind, with the
// submission at this stage?
//
// Production is deliberately allowed to accept copyediting-stage kinds: work
// that should have been filed during copyediting still has to go somewhere
// once the manuscript has moved on, and the alternative is an editor pushing
// it back a stage just to attach a file, which corrupts the stage history.
// The reverse is not allowed -- no production files before production.
function canUploadFile(stage, kindKey, actor) {
  const kind = FILE_KINDS_BY_KEY[kindKey];
  if (!kind) return false;
  if (!FILE_ROUND_STAGES.has(stage)) return false;
  if (kind.uploadableBy !== actor) return false;
  if (kind.stage === STAGES.PRODUCTION && stage !== STAGES.PRODUCTION) return false;
  return true;
}

// The author's view of the file rounds: only kinds marked authorVisible, and
// only the fields they need. Storage keys never cross this boundary.
function authorVisibleFiles(files) {
  return (files || [])
    .filter((f) => {
      const kind = FILE_KINDS_BY_KEY[f.kind];
      return Boolean(kind && kind.authorVisible);
    })
    .map((f) => ({
      id: f.id,
      kind: f.kind,
      kindLabel: (FILE_KINDS_BY_KEY[f.kind] || {}).label || f.kind,
      stage: f.stage,
      round: f.round,
      fileName: f.file ? f.file.fileName : '',
      fileSize: f.file ? f.file.fileSize : 0,
      note: f.note || '',
      uploadedBy: f.uploadedByRole === 'author' ? 'You' : 'Editorial office',
      uploadedAt: f.uploadedAt,
      needsAuthorAction: Boolean(f.needsAuthorAction),
      // Must travel with needsAuthorAction. Without it the author's view can
      // never tell an answered request from an outstanding one, and the
      // dashboard says "response needed" forever -- which is precisely the
      // thing that teaches someone to ignore the flag.
      answeredAt: f.answeredAt || '',
      // Deliberately omitted: storedFileName, uploadedById, uploadedByName.
      // An author has no need to know which editor handled their paper, and
      // storage keys are not theirs to hold.
    }));
}

// ---- Galleys ----
//
// A galley is a reader-facing rendition of the finished article: the PDF
// someone downloads, or the HTML they read in the browser. An article is not
// publishable without at least one.

const GALLEY_FORMATS = {
  pdf: { key: 'pdf', label: 'PDF', extensions: ['.pdf'], inline: true },
  html: { key: 'html', label: 'HTML (full text)', extensions: ['.html', '.htm'], inline: false },
  xml: { key: 'xml', label: 'XML', extensions: ['.xml'], inline: false },
};

// How a galley came to exist. The distinction is a security boundary, not
// bookkeeping: 'generated' galleys were built by lib/galley.js from escaped
// plain text and are therefore safe to render inside our own page, while
// 'uploaded' ones are third-party files that are only ever served as
// downloads. See routes/public.js.
const GALLEY_SOURCES = { UPLOADED: 'uploaded', GENERATED: 'generated' };

function galleyFormatForExtension(ext) {
  const norm = String(ext || '').toLowerCase();
  const hit = Object.values(GALLEY_FORMATS).find((f) => f.extensions.includes(norm));
  return hit ? hit.key : null;
}

// Galleys sort by explicit order, then by format so a list without any
// ordering set still comes out PDF-first, which is what readers expect.
const GALLEY_FORMAT_ORDER = ['pdf', 'html', 'xml'];

function sortGalleys(galleys) {
  return (galleys || []).slice().sort((a, b) => {
    const ao = Number.isFinite(a.order) ? a.order : 999;
    const bo = Number.isFinite(b.order) ? b.order : 999;
    if (ao !== bo) return ao - bo;
    const af = GALLEY_FORMAT_ORDER.indexOf(a.format);
    const bf = GALLEY_FORMAT_ORDER.indexOf(b.format);
    if (af !== bf) return af - bf;
    return String(a.label || '').localeCompare(String(b.label || ''));
  });
}

// ---- Publication readiness ----
//
// The gate on the Publish decision. Unlike the "reviews still outstanding"
// warning, this one cannot be forced: every blocker here would produce a
// public article page that is broken rather than merely premature -- a
// citation with no volume, or a "read the article" link with nothing behind
// it. An editor who wants to publish anyway has to fix the cause.

function publishBlockers(submission, galleys, issue) {
  const blockers = [];
  const list = galleys || [];
  if (!list.length) {
    blockers.push('Add at least one galley (the PDF or full-text HTML readers will open).');
  }
  if (!submission || !submission.issueId) {
    blockers.push('Assign this article to an issue.');
  } else if (!issue) {
    blockers.push('The issue this article is assigned to no longer exists. Reassign it.');
  }
  if (!submission || !String(submission.pages || '').trim()) {
    blockers.push('Record the page range, so the article can be cited.');
  }
  return blockers;
}

function isReadyToPublish(submission, galleys, issue) {
  return publishBlockers(submission, galleys, issue).length === 0;
}

// ---- Reviewer recommendations ----
// Matches the OJS reviewer form. Advisory only -- the editor's decision is
// what actually moves the submission.
const RECOMMENDATIONS = {
  accept: 'Accept Submission',
  minor_revisions: 'Revisions Required',
  resubmit_for_review: 'Resubmit for Review',
  resubmit_elsewhere: 'Resubmit Elsewhere',
  decline: 'Decline Submission',
  see_comments: 'See Comments',
};

// ---- Review assignment lifecycle ----
const ASSIGNMENT_STATUS = {
  PENDING: 'pending', // invited, reviewer hasn't responded
  ACCEPTED: 'accepted', // reviewer agreed, review not yet submitted
  DECLINED: 'declined', // reviewer turned it down
  COMPLETED: 'completed', // review submitted
  CANCELLED: 'cancelled', // editor withdrew the invitation
};

const ASSIGNMENT_STATUS_LABELS = {
  [ASSIGNMENT_STATUS.PENDING]: 'Awaiting reviewer response',
  [ASSIGNMENT_STATUS.ACCEPTED]: 'Review in progress',
  [ASSIGNMENT_STATUS.DECLINED]: 'Reviewer declined',
  [ASSIGNMENT_STATUS.COMPLETED]: 'Review submitted',
  [ASSIGNMENT_STATUS.CANCELLED]: 'Invitation withdrawn',
};

// ---- Roles ----
const ROLES = {
  AUTHOR: 'author',
  REVIEWER: 'reviewer',
  EDITOR: 'editor',
  MANAGING_EDITOR: 'managing_editor',
};

// Everyone is an author; the rest are granted. Editors are bootstrapped from
// the EDITOR_EMAILS env var (see config.js) so there's no self-signup path
// into a privileged role.
const ASSIGNABLE_ROLES = [ROLES.REVIEWER, ROLES.EDITOR, ROLES.MANAGING_EDITOR];

// Roles that are scoped to particular journals. A reviewer reviews for
// specific journals; a section editor handles specific journals. Managing
// editors are deliberately NOT scoped -- that's the whole point of the tier.
const JOURNAL_SCOPED_ROLES = [ROLES.REVIEWER, ROLES.EDITOR];

// Normalizes a user record's roles. Accepts the legacy single `role` string
// from records created before roles existed.
function userRoles(user) {
  if (!user) return [];
  if (Array.isArray(user.roles) && user.roles.length) return user.roles;
  if (user.role) return [user.role];
  return [ROLES.AUTHOR];
}

function hasRole(user, role) {
  return userRoles(user).includes(role);
}

// ---- Journal scoping ----
//
// Roles say WHAT someone may do; journalRoles say WHERE. The shape is:
//
//   user.journalRoles = { reviewer: ['alstm','jec'], editor: ['ipsb'] }
//
// An empty or missing list means no journals for that role -- strict rather
// than permissive, because the failure mode of guessing "all" is an editor
// silently able to decline another journal's papers.
//
// The one exception is the managing-editor tier, which spans everything.

function journalsForRole(user, role) {
  if (!user || !user.journalRoles) return [];
  const list = user.journalRoles[role];
  return Array.isArray(list) ? list : [];
}

// LOCKOUT SAFETY: an address listed in EDITOR_EMAILS is always treated as a
// managing editor, whatever the stored record says. Without this, a bad
// migration or a mistaken role edit could leave the journal with nobody able
// to reach its own submissions -- and no way in through the UI to fix it.
// `bootstrapEmails` is passed in rather than imported so this module stays
// free of config, and therefore testable.
function isManagingEditor(user, bootstrapEmails = []) {
  if (!user) return false;
  if (hasRole(user, ROLES.MANAGING_EDITOR)) return true;
  const email = String(user.email || '').trim().toLowerCase();
  return Boolean(email && bootstrapEmails.includes(email));
}

// May this person act as an editor on this journal?
function canEditJournal(user, journalCode, bootstrapEmails = []) {
  if (!user || !journalCode) return false;
  if (isManagingEditor(user, bootstrapEmails)) return true;
  if (!hasRole(user, ROLES.EDITOR)) return false;
  return journalsForRole(user, ROLES.EDITOR).includes(journalCode);
}

// May this person be invited to review for this journal?
// Managing-editor status confers no reviewing scope -- being in charge isn't
// the same as being a subject-matter reviewer.
function canReviewJournal(user, journalCode) {
  if (!user || !journalCode) return false;
  if (!hasRole(user, ROLES.REVIEWER)) return false;
  return journalsForRole(user, ROLES.REVIEWER).includes(journalCode);
}

// Every journal this person may act on as an editor. `allCodes` is supplied
// by the caller so this module needn't know the journal list.
function editableJournals(user, allCodes, bootstrapEmails = []) {
  if (isManagingEditor(user, bootstrapEmails)) return allCodes.slice();
  if (!hasRole(user, ROLES.EDITOR)) return [];
  return journalsForRole(user, ROLES.EDITOR).filter((c) => allCodes.includes(c));
}

// Normalizes a requested journal list: unknown codes dropped, duplicates
// removed. Prevents a typo'd code being stored and silently never matching.
function sanitiseJournals(codes, allCodes) {
  if (!Array.isArray(codes)) return [];
  return Array.from(new Set(codes.filter((c) => allCodes.includes(c))));
}

// ---- Anonymity ----
// Double-anonymous by default: reviewers never see author identity, and
// authors never see reviewer identity. `reviewerView` strips every
// identifying field from a submission before it goes to a reviewer.
const REVIEW_MODEL = 'double_anonymous';

// ".docx" from "Sharma-final-v3.docx". Used instead of the real filename in
// anything a reviewer sees.
function fileExtension(fileName) {
  const match = /\.[a-z0-9]+$/i.exec(String(fileName || ''));
  return match ? match[0].toLowerCase() : '';
}

function reviewerView(submission) {
  if (!submission) return null;
  return {
    id: submission.id,
    journalCode: submission.journalCode,
    journalName: submission.journalName,
    articleType: submission.articleType,
    subjectArea: submission.subjectArea,
    title: submission.title,
    abstract: submission.abstract,
    keywords: submission.keywords,
    // Declarations minus any free-text that commonly names the institution.
    declarations: {
      originality: submission.declarations ? submission.declarations.originality : false,
      ethicsCompliance: submission.declarations ? submission.declarations.ethicsCompliance : false,
    },
    // Only the file type and size -- NOT the original filename. Authors
    // routinely name manuscripts things like "Sharma-final-v3.docx", so
    // passing fileName through would defeat the rest of this stripping.
    // The download routes serve these under a neutral name too (see
    // lib/files.js anonymousFileName).
    manuscript: submission.manuscript
      ? { fileType: fileExtension(submission.manuscript.fileName), fileSize: submission.manuscript.fileSize }
      : null,
    supplementaryFiles: (submission.supplementaryFiles || []).map((f) => ({
      fileType: fileExtension(f.fileName),
      fileSize: f.fileSize,
    })),
    currentRound: submission.currentRound || 1,
    // Deliberately omitted: userId, correspondingAuthor, coAuthorsList,
    // coverLetter, suggestedReviewers, ethicsApprovalDetails,
    // conflictOfInterest, statusHistory, decisions, storedFileName keys.
  };
}

// What an author is allowed to see of a completed review: the recommendation
// and the comments written for them -- never the reviewer's identity, and
// never the confidential comments addressed to the editor.
function authorViewOfReview(assignment) {
  if (!assignment || assignment.status !== ASSIGNMENT_STATUS.COMPLETED) return null;
  return {
    round: assignment.round,
    recommendation: assignment.recommendation,
    recommendationLabel: RECOMMENDATIONS[assignment.recommendation] || assignment.recommendation,
    commentsForAuthor: assignment.commentsForAuthor || '',
    completedAt: assignment.completedAt,
    // Deliberately omitted: reviewerId, reviewerName, commentsForEditor.
  };
}

// ---- The public view of a published article ----
//
// The counterpart to reviewerView, and written the same way: an explicit
// whitelist rather than a blacklist of things to delete. A submission record
// accumulates fields for years -- cover letters, suggested reviewers,
// confidential editor notes, storage keys -- and a blacklist silently starts
// leaking the moment someone adds a field and forgets this function exists.
// Building the public object from nothing means a new field is invisible
// until somebody deliberately publishes it.
//
// `includeAuthorEmail` defaults to true because publishing the corresponding
// author's address is normal scholarly practice (it is how readers request
// data), but it is a flag rather than a fact because it is also an
// invitation to scrapers, and that is an editorial policy call.
function publicArticleView(submission, options) {
  if (!submission) return null;
  const opts = options || {};
  const includeAuthorEmail = opts.includeAuthorEmail !== false;
  const galleys = sortGalleys(opts.galleys || submission.galleys || []);
  const ca = submission.correspondingAuthor || {};

  return {
    id: submission.id,
    journalCode: submission.journalCode,
    journalName: submission.journalName,
    articleType: submission.articleType,
    subjectArea: submission.subjectArea || '',
    title: submission.title,
    abstract: submission.abstract,
    keywords: submission.keywords || '',
    authors: [
      {
        name: ca.name || '',
        affiliation: ca.affiliation || '',
        email: includeAuthorEmail ? ca.email || '' : '',
        corresponding: true,
      },
    ]
      .concat(
        (submission.coAuthorsList || []).map((p) => ({
          name: p.name || '',
          affiliation: p.affiliation || '',
          email: '',
          corresponding: false,
        }))
      )
      .filter((a) => a.name),
    doi: submission.doi || '',
    pages: submission.pages || '',
    license: submission.license || '',
    publishedAt: submission.publishedAt || '',
    galleys: galleys.map((g) => ({
      id: g.id,
      label: g.label,
      format: g.format,
      source: g.source,
      fileSize: g.file ? g.file.fileSize : 0,
    })),
    // Deliberately omitted: userId, editorId, coverLetter, suggestedReviewers,
    // declarations (ethics and conflict-of-interest free text the author wrote
    // for editorial eyes -- publish those only after saying so in the author
    // guidelines), statusHistory, decisions, notifications, manuscript,
    // supplementaryFiles, revisions, stageFiles, and every storedFileName.
  };
}

module.exports = {
  STAGES,
  STAGE_ORDER,
  STAGE_LABELS,
  TERMINAL_STAGES,
  DECISIONS,
  DECISIONS_BY_KEY,
  availableDecisions,
  isDecisionAllowed,
  RECOMMENDATIONS,
  ASSIGNMENT_STATUS,
  ASSIGNMENT_STATUS_LABELS,
  ROLES,
  ASSIGNABLE_ROLES,
  JOURNAL_SCOPED_ROLES,
  userRoles,
  hasRole,
  journalsForRole,
  isManagingEditor,
  canEditJournal,
  canReviewJournal,
  editableJournals,
  sanitiseJournals,
  REVIEW_MODEL,
  reviewerView,
  authorViewOfReview,
  FILE_KINDS,
  FILE_KINDS_BY_KEY,
  FILE_ROUND_STAGES,
  fileKindsForStage,
  canUploadFile,
  authorVisibleFiles,
  GALLEY_FORMATS,
  GALLEY_SOURCES,
  GALLEY_FORMAT_ORDER,
  galleyFormatForExtension,
  sortGalleys,
  publishBlockers,
  isReadyToPublish,
  publicArticleView,
};
