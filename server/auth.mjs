import * as oidc from 'openid-client';
import { equal, hash, HttpError, secret } from './launcher.mjs';

export async function authentication(config, store, client = oidc) {
  const oidcConfig = await client.discovery(new URL(`${config.identityURL}/oidc`), config.clientID, config.clientSecret, client.ClientSecretPost(config.clientSecret), config.production ? {} : { execute: [client.allowInsecureRequests] });
  const cookieName = config.production ? '__Host-lattice-launcher' : 'lattice-launcher';
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${config.production ? '; Secure' : ''}`;
  function session(req) {
    const value = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return {};
    return { id: hash(value), data: store.session(hash(value)) };
  }
  return {
    session,
    csrf(req, data) { if (req.headers.origin !== config.appURL || !data?.subject || !equal(req.headers['x-csrf-token'], data.csrf)) throw new HttpError(403, 'Invalid request origin or CSRF token'); },
    async login(req, res) {
      const old = session(req); if (old.id) store.deleteSession(old.id);
      const value = secret(); const verifier = client.randomPKCECodeVerifier();
      const state = client.randomState(); const nonce = client.randomNonce();
      store.saveSession(hash(value), { verifier, state, nonce }, Date.now() + 10 * 60_000);
      const url = client.buildAuthorizationUrl(oidcConfig, { redirect_uri: `${config.appURL}/auth/callback`, scope: 'openid profile', code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce });
      res.writeHead(302, { 'Set-Cookie': cookie(value, 600), Location: url.href }); res.end();
    },
    async callback(req, res) {
      const current = session(req);
      if (!current.data?.state || !current.data.verifier) throw new HttpError(401, 'Sign-in expired; start again');
      store.deleteSession(current.id);
      const tokens = await client.authorizationCodeGrant(oidcConfig, new URL(req.url, config.appURL), { pkceCodeVerifier: current.data.verifier, expectedState: current.data.state, expectedNonce: current.data.nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims?.sub || !Object.hasOwn(config.controllers, claims.sub)) throw new HttpError(403, 'This Identity user is not authorized to launch workspaces');
      const value = secret(); const expires = Math.min(Date.now() + 8 * 60 * 60_000, claims.exp * 1000);
      store.saveSession(hash(value), { subject: claims.sub, name: claims.name || claims.username || 'Identity user', csrf: secret() }, expires);
      res.writeHead(302, { 'Set-Cookie': cookie(value, Math.max(0, Math.floor((expires - Date.now()) / 1000))), Location: '/' }); res.end();
    },
    logout(req, res) { const current = session(req); if (current.id) store.deleteSession(current.id); res.writeHead(204, { 'Set-Cookie': cookie('', 0) }); res.end(); },
  };
}
