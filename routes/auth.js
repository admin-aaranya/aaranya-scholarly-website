const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const { JWT_SECRET, TOKEN_EXPIRY, EDITOR_EMAILS } = require('../config');
const { findUserByEmail, createUser, updateUser } = require('../db');
const { requireAuth, publicUser } = require('../middleware/auth');
const { ROLES, userRoles } = require('../lib/workflow');
const notifications = require('../lib/notifications');

const router = express.Router();

// Moved to lib/journals.js -- re-exported below so the several modules that
// already do `require('./auth').JOURNALS` keep working.
const { JOURNALS } = require('../lib/journals');

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

// Roles a brand-new account should get. Everyone is an author; addresses
// listed in EDITOR_EMAILS also get the editor role, which is the only way an
// editor comes into existence without an existing editor granting it.
function initialRoles(normEmail) {
  const roles = [ROLES.AUTHOR];
  if (EDITOR_EMAILS.includes(normEmail)) roles.push(ROLES.EDITOR);
  return roles;
}

// Applied on every login so that (a) legacy accounts created before roles
// existed get a proper roles array, and (b) adding an address to
// EDITOR_EMAILS promotes an existing account on its next login rather than
// requiring a manual Firestore edit.
async function reconcileRoles(user) {
  const current = userRoles(user);
  const shouldHaveEditor = EDITOR_EMAILS.includes(user.email);
  const needsEditor = shouldHaveEditor && !current.includes(ROLES.EDITOR);
  const needsMigration = !Array.isArray(user.roles) || !user.roles.length;

  if (!needsEditor && !needsMigration) return user;

  const roles = needsEditor ? current.concat(ROLES.EDITOR) : current;
  return (await updateUser(user.id, { roles })) || Object.assign({}, user, { roles });
}

router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, affiliation, country, orcid, journalInterest } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Full name is required.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (!affiliation || !String(affiliation).trim()) {
      return res.status(400).json({ error: 'Institution / affiliation is required.' });
    }
    if (journalInterest && !JOURNALS[journalInterest] && journalInterest !== 'unsure') {
      return res.status(400).json({ error: 'Unrecognized journal selection.' });
    }

    const normEmail = String(email).trim().toLowerCase();
    if (await findUserByEmail(normEmail)) {
      return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' });
    }

    const passwordHash = bcrypt.hashSync(String(password), 10);
    const user = {
      id: uuidv4(),
      name: String(name).trim(),
      email: normEmail,
      passwordHash,
      affiliation: String(affiliation).trim(),
      country: country ? String(country).trim() : '',
      orcid: orcid ? String(orcid).trim() : '',
      journalInterest: journalInterest || 'unsure',
      roles: initialRoles(normEmail),
      createdAt: new Date().toISOString(),
    };
    await createUser(user);

    const token = signToken(user);
    res.status(201).json({ token, user: publicUser(user) });

    // Welcome email, after the response. If mail is down or unconfigured the
    // account is still created and usable -- registration must never depend
    // on an email going out.
    //
    // The timestamp is recorded only if the message actually went out, so a
    // registration during a mail outage stays in the backfill's pending list
    // and gets its welcome once the problem is fixed.
    notifications
      .accountCreated({ user, journals: JOURNALS })
      .then((stubs) => {
        const status = stubs && stubs[0] && stubs[0].status;
        if (status === 'sent' || status === 'logged') {
          return updateUser(user.id, { welcomeEmailSentAt: new Date().toISOString() });
        }
        return null;
      })
      .catch((e) => console.error('[auth] could not record welcome timestamp:', e && e.message));
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const found = await findUserByEmail(email);
    if (!found || !bcrypt.compareSync(String(password), found.passwordHash)) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    const user = await reconcileRoles(found);
    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.get('/journals', (_req, res) => {
  res.json({ journals: JOURNALS });
});

module.exports = router;
module.exports.JOURNALS = JOURNALS;
