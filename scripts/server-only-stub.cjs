// The `server-only` package throws when required outside a React Server
// Component graph. The channel worker IS server-only by construction (a bare
// Node process, no React, no request), so the guard has nothing to protect and
// is stubbed away here — and ONLY here.
module.exports = {};
