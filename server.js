const express = require('express');
const path = require('path');

const { PORT, SITE_URL } = require('./config');
const { ensureStore } = require('./db');
const { canonicalHost } = require('./lib/canonical-host');
const authRoutes = require('./routes/auth');
const submissionRoutes = require('./routes/submissions');
const editorialRoutes = require('./routes/editorial');
const reviewRoutes = require('./routes/reviews');
const cronRoutes = require('./routes/cron');
const productionRoutes = require('./routes/production');
const publicRoutes = require('./routes/public');

ensureStore();

const app = express();

// One address for the journal. Every public host other than SITE_URL is
// 301'd to it -- Firebase Hosting's *.web.app domain cannot be switched off,
// so this is how it stops being a second front door. Mounted first, so a
// redirected request never reaches a route or the datastore.
//
// Deliberately does not touch POSTs, the raw *.run.app URL, or localhost.
// See lib/canonical-host.js for why each of those would break something.
app.use(canonicalHost(SITE_URL));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', authRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/editorial', editorialRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/cron', cronRoutes);
app.use('/api/editorial/production', productionRoutes);

// The public archive: /archive/:journalCode, /issue/:id, /article/:id and the
// read-only JSON under /api/public. Mounted before express.static so these
// paths are never shadowed by a file of the same name, and after every
// authenticated router so it can never be reached with a token in hand by
// accident.
app.use('/', publicRoutes);

// Serve the static site (index.html, journals/, register.html, login.html, etc.)
app.use(express.static(__dirname, { extensions: ['html'] }));

// Basic error handler (e.g. multer errors that slip through)
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`Aaranya Scholarly website running at http://localhost:${PORT}`);
});
