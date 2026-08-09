// The author's pre-submission assistant: prompt, response schema, and the
// normalisation that keeps a model response from reaching the browser in a
// shape the page can't render.
//
// WHAT THIS IS, AND MORE IMPORTANTLY WHAT IT IS NOT
// ------------------------------------------------
// It is a readiness check an author runs on their own manuscript before they
// submit it. It reports on presentation and on completeness of reporting:
// is the structure there, is the language clean, did the methods say how many
// subjects and which statistical test, do the results actually answer the
// question the introduction posed.
//
// It is NOT peer review, and the prompt below works hard to keep it from
// drifting into peer review. It must not judge novelty, importance or whether
// the work should be published; it must not say the science is right or
// wrong. Those are human judgements that belong to reviewers and editors, and
// a journal that quietly outsourced them to a language model would deserve
// everything that followed.
//
// Three structural safeguards back that up:
//   * authors only -- reviewers and editors have no route to this endpoint,
//     so an AI opinion can never enter the review record
//   * advisory only -- output never gates submission (see routes/assistant.js)
//   * no persistence of findings on the submission, so nothing an editor
//     later reads is coloured by what a model guessed

// Reporting guidelines by study type. Naming the right one matters: telling a
// case report author about CONSORT randomisation items is noise, and noise is
// how authors learn to ignore the tool.
const REPORTING_STANDARDS = {
  'Original Research Article':
    'If it reports a randomised trial, use CONSORT. If it is observational (cohort, ' +
    'case-control, cross-sectional), use STROBE. If it involves live animals, use ARRIVE. ' +
    'If it is a laboratory or in-vitro study with no such guideline, apply general ' +
    'IMRaD reporting completeness instead.',
  'Systematic Review / Meta-Analysis': 'Use PRISMA 2020.',
  'Case Report': 'Use CARE.',
  'Short Communication':
    'Apply general IMRaD reporting completeness, scaled to the shorter format — brevity ' +
    'is expected and is not a gap.',
  'Technical Note / Protocol': 'Use SPIRIT where it is a study protocol; otherwise assess reproducibility of the described procedure.',
  'Review Article': 'No checklist applies. Assess scope statement, search or selection strategy if any is claimed, and structure.',
  'Data Paper': 'Assess whether the data are described well enough to be reused: provenance, format, licence, access route, and variable definitions.',
};

const DEFAULT_STANDARD =
  'No formal reporting checklist applies to this article type. Apply general academic ' +
  'writing and structural completeness only.';

function systemInstruction() {
  return [
    'You are a manuscript preparation assistant for Aaranya Scholarly, an academic publisher.',
    'You are helping an AUTHOR improve their own manuscript BEFORE they submit it.',
    '',
    'YOUR SCOPE — you may comment on:',
    '  1. Formatting and structure: presence and ordering of the expected sections, heading',
    '     consistency, abstract structure and length, keyword quality, figure and table',
    '     captions, reference list formatting consistency, in-text citation style consistency.',
    '  2. Language: spelling, grammar, punctuation, tense consistency, hedging, sentence',
    '     length, undefined abbreviations, inconsistent terminology for the same concept.',
    '  3. Completeness of reporting in the methods: sample size and how it was arrived at,',
    '     inclusion and exclusion criteria, randomisation and blinding where claimed,',
    '     controls, instruments and reagents with enough detail to reproduce, the named',
    '     statistical tests, the software used, and the ethics approval or consent statement.',
    '  4. Completeness of reporting in the results: whether every aim stated in the',
    '     introduction has a corresponding result, whether numbers carry dispersion measures',
    '     and exact p-values rather than bare "significant", whether every figure and table',
    '     is referred to in the text, whether the discussion draws conclusions the results',
    '     do not support, and whether limitations are stated.',
    '',
    'HARD LIMITS — you must NOT:',
    '  * judge novelty, significance, or whether the work merits publication;',
    '  * recommend acceptance or rejection, or imply either;',
    '  * assess whether the scientific conclusions are correct;',
    '  * rewrite the manuscript or draft new content for the author;',
    '  * invent findings. If you cannot see something in the text, say it appears to be',
    '    absent rather than asserting it is absent — a converted file may have dropped it.',
    '',
    'You are not a peer reviewer and you must not present yourself as one. Your output',
    'goes only to the author, is advisory, and never affects the editorial decision.',
    '',
    'TONE: address the author directly and plainly. Be specific — "the methods do not state',
    'which statistical test produced the p-values in Table 2" is useful; "improve the methods"',
    'is not. Where you quote the manuscript, quote it exactly and briefly. Many of these',
    'authors do not write in English as a first language; correct the writing without',
    'condescension and never comment on the author\'s English ability itself.',
    '',
    'Report at most 25 findings. If there are more, keep the ones that matter most.',
    'If the manuscript is genuinely in good shape, say so and return few findings — do not',
    'manufacture problems to look useful.',
  ].join('\n');
}

// Vertex's responseSchema is an OpenAPI 3 subset: uppercase type names, and
// propertyOrdering to fix the generation order (which also makes the model
// write its summary after it has enumerated findings, not before).
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    checkedAgainst: {
      type: 'STRING',
      description: 'The reporting guideline applied, or "General academic structure".',
    },
    strengths: {
      type: 'ARRAY',
      description: 'Up to 3 things the manuscript already does well. May be empty.',
      items: { type: 'STRING' },
    },
    findings: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          category: {
            type: 'STRING',
            enum: [
              'structure',
              'language',
              'formatting',
              'methods',
              'results',
              'statistics',
              'ethics',
              'references',
            ],
          },
          severity: {
            type: 'STRING',
            description:
              'likely_required = most journals would ask for this before review; ' +
              'worth_addressing = would strengthen the manuscript; ' +
              'suggestion = optional polish.',
            enum: ['likely_required', 'worth_addressing', 'suggestion'],
          },
          location: {
            type: 'STRING',
            description:
              'Where in the manuscript, e.g. "Methods, paragraph 2" or "Table 2". ' +
              'Use "Throughout" if it is not localised.',
          },
          issue: { type: 'STRING', description: 'What is missing or wrong. One or two sentences.' },
          suggestion: {
            type: 'STRING',
            description: 'What the author should do about it. Concrete and actionable.',
          },
        },
        propertyOrdering: ['category', 'severity', 'location', 'issue', 'suggestion'],
        required: ['category', 'severity', 'location', 'issue', 'suggestion'],
      },
    },
    summary: {
      type: 'STRING',
      description:
        'Two or three sentences to the author summarising what to fix first. ' +
        'Must not comment on whether the work is publishable.',
    },
  },
  propertyOrdering: ['checkedAgainst', 'strengths', 'findings', 'summary'],
  required: ['checkedAgainst', 'findings', 'summary'],
};

// The user-turn prompt. Metadata the author already typed is included because
// it lets the model check the abstract against the manuscript and catch the
// common "title says X, paper is about Y" mismatch.
function userPrompt({ articleType, journalName, title, abstract, keywords }) {
  const standard = REPORTING_STANDARDS[articleType] || DEFAULT_STANDARD;
  const lines = [
    `Journal: ${journalName || 'Not specified'}`,
    `Article type: ${articleType || 'Not specified'}`,
    '',
    `Reporting guideline to apply: ${standard}`,
    '',
  ];
  if (title) lines.push(`Title as entered on the submission form: ${title}`);
  if (keywords) lines.push(`Keywords as entered: ${keywords}`);
  if (abstract) lines.push('', 'Abstract as entered on the submission form:', abstract);
  lines.push(
    '',
    'The manuscript follows. Check it as instructed and return your findings.',
    'Also check that the title, abstract and keywords above match what the manuscript',
    'actually reports — a mismatch is a finding worth raising.'
  );
  return lines.join('\n');
}

const CATEGORIES = new Set([
  'structure',
  'language',
  'formatting',
  'methods',
  'results',
  'statistics',
  'ethics',
  'references',
]);
const SEVERITIES = new Set(['likely_required', 'worth_addressing', 'suggestion']);
const SEVERITY_RANK = { likely_required: 0, worth_addressing: 1, suggestion: 2 };
const MAX_FINDINGS = 25;

function str(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max && s.length > max ? `${s.slice(0, max)}…` : s;
}

// Constrained decoding makes valid JSON very likely but not certain, and
// "very likely" is not a contract. Everything below assumes the model may
// have returned nonsense and coerces it into something the page can render.
function normalise(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};

  const findings = (Array.isArray(src.findings) ? src.findings : [])
    .map((f) => {
      if (!f || typeof f !== 'object') return null;
      const issue = str(f.issue, 600);
      if (!issue) return null;
      return {
        category: CATEGORIES.has(f.category) ? f.category : 'structure',
        severity: SEVERITIES.has(f.severity) ? f.severity : 'suggestion',
        location: str(f.location, 120) || 'Throughout',
        issue,
        suggestion: str(f.suggestion, 600),
      };
    })
    .filter(Boolean)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, MAX_FINDINGS);

  const counts = { likely_required: 0, worth_addressing: 0, suggestion: 0 };
  for (const f of findings) counts[f.severity] += 1;

  return {
    checkedAgainst: str(src.checkedAgainst, 200) || 'General academic structure',
    strengths: (Array.isArray(src.strengths) ? src.strengths : [])
      .map((s) => str(s, 300))
      .filter(Boolean)
      .slice(0, 3),
    findings,
    counts,
    summary: str(src.summary, 1200),
  };
}

module.exports = {
  systemInstruction,
  userPrompt,
  normalise,
  RESPONSE_SCHEMA,
  REPORTING_STANDARDS,
  DEFAULT_STANDARD,
  CATEGORIES,
  SEVERITIES,
  MAX_FINDINGS,
};
