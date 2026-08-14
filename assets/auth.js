/* ============================================================
   AARANYA SCHOLARLY — shared client-side auth helpers.
   Include on every page. Reads data-base on <body> to build
   correct relative links ("./" for root pages, "../" for
   journals/*.html).
   ============================================================ */
(function () {
  const base = (document.body && document.body.getAttribute('data-base')) || './';
  const TOKEN_KEY = 'aaranya_token';
  const USER_KEY = 'aaranya_user';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }
  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY));
    } catch (e) {
      return null;
    }
  }
  function saveSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
  function isLoggedIn() {
    return !!(getToken() && getUser());
  }

  // Redirect to login if not authenticated, preserving where to return to.
  function requireAuth() {
    if (!isLoggedIn()) {
      const next = encodeURIComponent(window.location.pathname.split('/').pop() + window.location.search);
      window.location.href = base + 'login.html?next=' + next;
      return false;
    }
    return true;
  }

  // fetch wrapper that attaches the bearer token and clears session on 401.
  async function apiFetch(path, options) {
    options = options || {};
    const headers = Object.assign({}, options.headers || {});
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(path, Object.assign({}, options, { headers }));
    if (res.status === 401) clearSession();
    return res;
  }

  function logout(redirectTo) {
    clearSession();
    window.location.href = base + (redirectTo || 'index.html');
  }

  // Toggle the header "Author Login" button into "My Dashboard" + "Logout"
  // when a session exists. Looks for #authLoginBtn / #authSubmitBtn, which
  // every page's nav cta-slot defines.
  function wireNav() {
    const loginBtn = document.getElementById('authLoginBtn');
    if (!loginBtn) return;
    const user = getUser();

    if (isLoggedIn() && user) {
      // First name only, and no "My" -- this button sits in a nav bar that is
      // already competing for width, and logging in ADDS a second button next
      // to it. A long label here is what pushed the links onto a second line.
      // A very long first name is truncated by CSS rather than by cutting the
      // string, so the full name still reads correctly on hover.
      const first = user.name.split(' ')[0];
      loginBtn.textContent = 'Dashboard (' + first + ')';
      loginBtn.title = user.name;
      loginBtn.href = base + 'dashboard.html';

      const registerBtn = document.getElementById('authRegisterBtn');
      if (registerBtn) registerBtn.style.display = 'none';

      if (!document.getElementById('authLogoutBtn')) {
        const logoutBtn = document.createElement('a');
        logoutBtn.id = 'authLogoutBtn';
        logoutBtn.className = 'btn btn-outline';
        logoutBtn.href = '#';
        logoutBtn.textContent = 'Log Out';
        logoutBtn.addEventListener('click', function (e) {
          e.preventDefault();
          logout('index.html');
        });
        loginBtn.insertAdjacentElement('afterend', logoutBtn);
      }
    }
  }

  window.AaranyaAuth = {
    base,
    getToken,
    getUser,
    saveSession,
    clearSession,
    isLoggedIn,
    requireAuth,
    apiFetch,
    logout,
  };

  document.addEventListener('DOMContentLoaded', wireNav);
})();
