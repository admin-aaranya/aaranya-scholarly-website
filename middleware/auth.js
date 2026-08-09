const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const { findUserById } = require('../db');
const { userRoles, hasRole } = require('../lib/workflow');

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  // Always report a normalized roles array, even for legacy records that only
  // have the old single `role` string.
  rest.roles = userRoles(user);
  return rest;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await findUserById(payload.sub);
    if (!user) {
      return res.status(401).json({ error: 'Account no longer exists.' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// Guards a route to holders of a given role. Must be mounted after
// requireAuth. 403 (not 404) is intentional: the caller is authenticated, we
// just won't let them through, and hiding that fact from a logged-in user
// buys nothing here.
function requireRole(role) {
  return function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Not signed in.' });
    }
    if (!hasRole(req.user, role)) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, publicUser };
