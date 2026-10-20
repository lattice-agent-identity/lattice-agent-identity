import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from './main.mjs';
import { readConfig } from './config.mjs';
import { HttpError } from './launcher.mjs';

test('HTTP API never exposes source, configuration, unauthenticated launch or cross-origin writes', async t => {
  const config = { appURL: 'http://localhost', production: false };
  const store = { list: () => [] };
  let session;
  const auth = { session: () => ({ data: session }), csrf(req) { if (req.headers.origin !== config.appURL || req.headers['x-csrf-token'] !== 'csrf') throw new HttpError(403, 'CSRF'); } };
  const launcher = { authorized() {}, launch: async () => ({ id: 'launch' }) };
  const server = createApp(config, store, launcher, auth); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/session')).status, 200);
  assert.equal((await fetch(base + '/api/launch', { method: 'POST' })).status, 401);
  session = { subject: 'alice', csrf: 'csrf' };
  for (const path of ['/.env', '/server/config.mjs', '/workstations/go.mod', '/../.git/config']) assert.equal((await fetch(base + path)).status, 404);
  assert.equal((await fetch(base + '/api/launch', { method: 'POST', headers: { Origin: 'https://evil.example', 'X-CSRF-Token': 'csrf' } })).status, 403);
  const headers = { Origin: config.appURL, 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/launch', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(base + '/api/launch', { method: 'POST', headers, body: JSON.stringify({ requestId: 'x' }) })).status, 202);
  const home = await fetch(base + '/'); assert.equal(home.status, 200); assert(home.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
});

test('production config requires TLS, explicit controller mappings and secrets', () => {
  assert.throws(() => readConfig({}), /required/);
  const env = { NODE_ENV: 'production', APP_URL: 'http://localhost', IDENTITY_URL: 'https://id.example', WORKSTATIONS_URL: 'https://workspace.example', LAUNCH_CONTROLLERS: '{"alice":"11111111-1111-1111-1111-111111111111"}' };
  assert.throws(() => readConfig(env), /HTTPS/);
  assert.throws(() => readConfig({ ...env, LAUNCH_CONTROLLERS: '{}' }), /must map/);
});
