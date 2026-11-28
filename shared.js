// Shared helpers for all pages: talk to the server API, check the login, escape text.
(function () {
  const HOME = {
    admin: 'admin.html',
    teacher: 'espace_prof.html',
    student: 'espace_etudiant.html',
  };

  // Server error codes -> messages shown to people.
  const MESSAGES = {
    bad_credentials: 'Identifiant ou mot de passe incorrect.',
    not_logged_in: 'Votre session a expiré. Veuillez vous reconnecter.',
    forbidden: "Vous n'avez pas accès à cette action.",
    missing_fields: 'Veuillez remplir tous les champs obligatoires.',
    missing_name: 'Le nom est obligatoire.',
    login_id_taken: 'Cet identifiant existe déjà.',
    not_a_teacher: "Cet utilisateur n'est pas un enseignant.",
    class_not_found: 'Classe introuvable.',
    session_not_found: 'Séance introuvable.',
    session_closed: 'La séance est terminée ou fermée.',
    invalid_token: 'QR Code invalide.',
    invalid_or_expired_token: 'QR Code expiré ou invalide. Scannez le code actuellement affiché.',
    not_enrolled: "Vous n'êtes pas inscrit à ce cours.",
    bad_list: 'Liste invalide.',
    server_error: 'Erreur du serveur. Réessayez plus tard.',
    network: 'Impossible de joindre le serveur.',
  };

  const message = (code) => MESSAGES[code] || 'Une erreur est survenue.';

  // api('POST', '/api/login', { ... }) -> parsed JSON. Throws an Error with .code and .detail on failure.
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      const e = new Error(message('network'));
      e.code = 'network';
      throw e;
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const code = (data && data.error) || 'server_error';
      const e = new Error(message(code));
      e.code = code;
      e.status = res.status;
      e.detail = data && data.detail;
      // A login that is no longer valid: go back to the login page.
      if (res.status === 401 && code === 'not_logged_in' && !location.pathname.endsWith('index.html') && location.pathname !== '/') {
        location.href = 'index.html';
      }
      throw e;
    }
    return data;
  }

  // Call at the top of a page: makes sure someone with the right role is logged in.
  // Sends everyone else to the login page (or to their own page). Returns the user.
  async function requireRole(role) {
    try {
      const me = await api('GET', '/api/me');
      if (me.role !== role) {
        location.href = HOME[me.role] || 'index.html';
        return new Promise(() => {}); // never resolves: the page is leaving
      }
      return me;
    } catch {
      location.href = 'index.html';
      return new Promise(() => {});
    }
  }

  async function logout() {
    try { await api('POST', '/api/logout'); } catch { /* leave anyway */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
    location.href = 'index.html';
  }

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const fmtTime = (unixSeconds) => (unixSeconds
    ? new Date(unixSeconds * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : '-');
  const fmtDateTime = (unixSeconds) => new Date(unixSeconds * 1000)
    .toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

  window.App = { api, requireRole, logout, esc, fmtTime, fmtDateTime, message, HOME };
})();
