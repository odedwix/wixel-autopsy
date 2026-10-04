// Local dev server only: a back-office sign-in cookie for a made-up staff user, encrypted with the
// public development key the dev server accepts. Paste the printed line into the browser console on
// any http://localhost page (cookies ignore ports), then open http://localhost:8091/serverless/test-scope/
const c = require('@wix/wnp-bo-auth-crypto');
const email = process.argv[2] || 'dev.tester@wix.com';
const value = c.encrypt({ accessToken: 'dev', displayName: 'Dev Tester', email, imageUrl: '' }, c.devCryptoKey);
console.log(`document.cookie = "${c.cookieKey}=${encodeURIComponent(value)}; path=/"`);
