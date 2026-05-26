// Auth via shared secret token. The web app is deployed ANYONE_ANONYMOUS
// (required so the static Cloudflare frontend can fetch cross-origin without
// a Google login redirect), and Session.getActiveUser() is empty on a
// personal-Gmail-owned app, so a Google-identity allowlist is not viable here.
// The token is set as the API_TOKEN script property and entered once per device
// in the frontend (stored in localStorage, never committed). Sent on every request.

const getApiToken_ = () => PropertiesService.getScriptProperties().getProperty('API_TOKEN');

// Constant-time-ish compare to avoid trivially leaking length/prefix via timing.
const tokensMatch_ = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

// Wraps a handler so it only runs when the request carries the shared token.
const withAuth_ = (fn) => (params) => {
  const expected = getApiToken_();
  if (!expected) return { ok: false, error: 'server missing API_TOKEN' };
  if (!tokensMatch_(params && params.token, expected)) {
    return { ok: false, error: 'unauthorized' };
  }
  return fn(params);
};
