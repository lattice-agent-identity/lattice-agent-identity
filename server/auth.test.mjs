import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authentication } from './auth.mjs';
import { Store } from './store.mjs';

async function fixture(t, subject = 'alice') {
  const store = new Store(':memory:'); t.after(() => store.close());
  const config = { identityURL: 'https://id.example.com', appURL: 'https://launch.example.com', production: true, clientID: 'client', clientSecret: 'private', controllers: { alice: 'owner' } };
  let authorization; let checks; let discoveryOptions;
  const client = {
    ClientSecretPost: value => ({ value }),
    discovery: async (...args) => { discoveryOptions = args[4]; return {}; },
    randomPKCECodeVerifier: () => 'verifier', randomState: () => 'state', randomNonce: () => 'nonce',
    calculatePKCECodeChallenge: async () => 'S256-challenge',
    buildAuthorizationUrl: (_, params) => { authorization = params; return new URL('https://id.example.com/oidc/auth'); },
    authorizationCodeGrant: async (_, url, values) => { checks = values; assert.equal(url.origin, config.appURL); return { claims: () => ({ sub: subject, exp: Math.floor(Date.now() / 1000) + 3600 }) }; },
  };
  const auth = await authentication(config, store, client);
  const response = () => ({ writeHead(status, headers) { this.status = status; this.headers = headers; }, end() {} });
  return { auth, store, response, authorization: () => authorization, checks: () => checks, discoveryOptions: () => discoveryOptions };
}

test('OIDC uses PKCE/state/nonce and rotates a secure hashed session after callback', async t => {
  const f = await fixture(t); const res = f.response();
  await f.auth.login({ headers: {} }, res);
  assert.equal(res.status, 302);
  assert.match(res.headers['Set-Cookie'], /^__Host-lattice-launcher=/);
  assert.match(res.headers['Set-Cookie'], /HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  const cookie = res.headers['Set-Cookie'].split(';')[0];
  const pending = f.auth.session({ headers: { cookie } });
  assert(!pending.data.subject); assert(!pending.id.includes(cookie.split('=')[1]));
  assert.deepEqual(f.authorization(), { redirect_uri: 'https://launch.example.com/auth/callback', scope: 'openid profile', code_challenge: 'S256-challenge', code_challenge_method: 'S256', state: 'state', nonce: 'nonce' });
  const callback = f.response(); await f.auth.callback({ headers: { cookie }, url: '/auth/callback?code=code&state=state' }, callback);
  assert.deepEqual(f.checks(), { pkceCodeVerifier: 'verifier', expectedState: 'state', expectedNonce: 'nonce', idTokenExpected: true });
  assert.deepEqual(f.discoveryOptions(), {});
  assert.equal(f.store.session(pending.id), undefined);
  assert.notEqual(callback.headers['Set-Cookie'], res.headers['Set-Cookie']);
  const current = f.auth.session({ headers: { cookie: callback.headers['Set-Cookie'].split(';')[0] } });
  assert.equal(current.data.subject, 'alice');
  assert.throws(() => f.auth.csrf({ headers: { origin: 'https://evil.example.com', 'x-csrf-token': current.data.csrf } }, current.data), { status: 403 });
  f.auth.csrf({ headers: { origin: 'https://launch.example.com', 'x-csrf-token': current.data.csrf } }, current.data);
});

test('OIDC rejects an unmapped subject and consumes the pending login', async t => {
  const f = await fixture(t, 'mallory'); const res = f.response();
  await f.auth.login({ headers: {} }, res);
  const cookie = res.headers['Set-Cookie'].split(';')[0];
  await assert.rejects(f.auth.callback({ headers: { cookie }, url: '/auth/callback?code=code' }, f.response()), { status: 403 });
  assert.equal(f.auth.session({ headers: { cookie } }).data, undefined);
});

test('OIDC callback cannot create a session without a pending browser login', async t => {
  const f = await fixture(t);
  await assert.rejects(f.auth.callback({ headers: {}, url: '/auth/callback?code=code' }, f.response()), { status: 401 });
});
