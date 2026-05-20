// Hard allowlist - shared family account only.
const ALLOWED_USERS = ['soleilandtyler@gmail.com'];

// Wraps a handler so it only runs for allowlisted users.
const withAuth_ = (fn) => (params) => {
  const email = Session.getActiveUser().getEmail();
  if (ALLOWED_USERS.indexOf(email) === -1) {
    return { ok: false, error: 'unauthorized' };
  }
  return fn(params);
};
