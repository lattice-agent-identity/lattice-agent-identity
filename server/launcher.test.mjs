import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Launcher, hash, publicKey } from './launcher.mjs';
import { Store } from './store.mjs';

function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const config = { controllers: { alice: 'owner' }, organizationID: 'org', templateID: 'template', appURL: 'https://launch.example.com', identityURL: 'https://identity.example.com', workstationsURL: 'https://workspace.example.com', bootstrapTTL: 60000, maxWorkspaces: 3 };
  const calls = []; let bootstrapToken;
  const workspace = { id: 'workspace', owner_id: 'owner', latest_build: { status: 'running', resources: [{ agents: [{ status: 'connected', lifecycle_state: 'ready' }] }] } };
  const api = {
    metadata: async () => ({ issuer: `${config.identityURL}/oidc` }),
    identity: async (path, method, body) => {
      calls.push({ service: 'identity', path, method, body });
      if (path === '/agent-identities') return { principal: { id: 'agent' } };
      if (path.endsWith('/key-challenges')) return { challengeId: 'challenge', nonce: 'nonce' };
      if (path.endsWith('/security')) return { grants: [] };
      return {};
    },
    workstations: async (path, method, body, token) => {
      calls.push({ service: 'workstations', path, method, body, token });
      if (path === '/templates/template') return { organization_id: 'org' };
      if (path.endsWith('/settings/workspace-sharing')) return { shareable_workspace_owners: 'everyone', sharing_globally_disabled: false };
      if (path === '/users/owner') return { username: 'owner', status: 'active', is_service_account: false };
      if (path === '/users/owner/organizations') return [{ id: 'org' }];
      if (path === '/users/owner/workspaces') { bootstrapToken = body.rich_parameter_values[0].value; return workspace; }
      if (path === '/workspaces/workspace') return workspace;
      if (path === '/users') return { id: 'agent-user' };
      if (path === '/users/me') return { id: token === 'agent-token' ? 'agent-user' : 'other-user', status: 'active', is_service_account: true };
      return {};
    },
  };
  const launcher = new Launcher(config, store, api);
  return { launcher, store, config, api, calls, workspace, token: () => bootstrapToken };
}

test('launch is authenticated, organization-bound, idempotent, and returns no bootstrap secrets', async t => {
  const f = fixture(t); const requestID = randomUUID();
  await assert.rejects(f.launcher.launch('mallory', requestID), { status: 403 });
  await assert.rejects(f.launcher.launch('alice', 'bad'), { status: 400 });
  const [a, b] = await Promise.all([f.launcher.launch('alice', requestID), f.launcher.launch('alice', requestID)]);
  assert.deepEqual(a, b); assert.equal(f.calls.filter(c => c.path === '/agent-identities').length, 1);
  assert(!JSON.stringify(a).includes(f.token()));
  assert.equal(f.store.get(a.id).bootstrapHash, hash(f.token()));
  assert.equal(f.calls.find(c => c.path === '/agent-identities').body.controller.entityId, 'alice');
  assert.equal(f.calls.find(c => c.path === '/users/owner/workspaces').body.template_id, 'template');
  await assert.rejects(f.launcher.status('mallory', a.id), { status: 403 });
  f.config.controllers.bob = 'owner';
  await assert.rejects(f.launcher.status('bob', a.id), { status: 404 });
});

test('rejects templates from another organization and controller account mismatches', async t => {
  const f = fixture(t);
  f.config.organizationID = 'wrong';
  await assert.rejects(f.launcher.launch('alice', randomUUID()), { status: 503 });
  assert.equal(f.calls.filter(c => c.service === 'identity').length, 0);
});

test('controller quotas are serialized under concurrent launch attempts', async t => {
  const f = fixture(t); f.config.maxWorkspaces = 1;
  const attempts = await Promise.allSettled([f.launcher.launch('alice', randomUUID()), f.launcher.launch('alice', randomUUID())]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.status, 409);
});

test('bootstrap requires the capability, binds exactly one public key and verifies possession', async t => {
  const f = fixture(t); const launch = await f.launcher.launch('alice', randomUUID());
  const key = generateKeyPairSync('ed25519'); const jwk = key.publicKey.export({ format: 'jwk' });
  await assert.rejects(f.launcher.challenge(launch.id, 'wrong-token', jwk), { status: 401 });
  const challenge = await f.launcher.challenge(launch.id, f.token(), jwk);
  assert.deepEqual(await f.launcher.challenge(launch.id, f.token(), jwk), challenge);
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  await assert.rejects(f.launcher.challenge(launch.id, f.token(), other), { status: 409 });
  await assert.rejects(f.launcher.verify(launch.id, f.token(), { nonce: 'wrong', signature: 'bad' }), { status: 401 });
  const signature = sign(null, Buffer.from(`openagent-challenge:${challenge.challengeId}:${challenge.nonce}`), key.privateKey).toString('base64url');
  const request = { nonce: challenge.nonce, signature };
  const result = await f.launcher.verify(launch.id, f.token(), request);
  assert.equal(result.agentID, 'agent'); assert.equal(result.workspaceID, 'workspace');
  assert.equal(f.calls.find(c => c.path.endsWith('/acl')).body.user_roles['agent-user'], 'use');
  assert.deepEqual(f.calls.find(c => c.path.endsWith('/agent-user/roles')).body.roles, ['organization-workspace-creation-ban']);
  const grants = f.calls.filter(c => c.path.endsWith('/service-grants'));
  assert.deepEqual(grants[0].body, { service: 'workstations', scopes: ['workstations:access'] });
  assert.deepEqual(await f.launcher.verify(launch.id, f.token(), request), result);
  assert.equal(f.calls.filter(c => c.path === '/users').length, 1);
  await assert.rejects(f.launcher.challenge(launch.id, f.token(), other), { status: 409 });
  await assert.rejects(f.launcher.ready(launch.id, 'wrong-agent-token'), { status: 403 });
  await f.launcher.ready(launch.id, 'agent-token');
  assert.equal((await f.launcher.status('alice', launch.id)).state, 'ready');
  f.workspace.latest_build.status = 'stopped';
  assert.equal((await f.launcher.status('alice', launch.id)).state, 'unavailable');
  const row = f.store.get(launch.id); row.expires = Date.now() - 1; f.store.save(row);
  await assert.rejects(f.launcher.challenge(launch.id, f.token(), jwk), { status: 401 });
});

test('private JWKs and malformed keys cannot be submitted', () => {
  assert.throws(() => publicKey({ kty: 'OKP', crv: 'Ed25519', x: 'a'.repeat(43), d: 'private' }), { status: 400 });
  assert.throws(() => publicKey({ kty: 'RSA' }), { status: 400 });
});

test('ready signal cannot bypass workspace runtime readiness', async t => {
  const f = fixture(t); const launch = await f.launcher.launch('alice', randomUUID());
  const row = f.store.get(launch.id); row.used = true; row.agentUserID = 'agent-user'; f.store.save(row);
  f.workspace.latest_build.status = 'starting';
  await f.launcher.ready(launch.id, 'agent-token');
  assert.notEqual((await f.launcher.status('alice', launch.id)).state, 'ready');
});

test('state, idempotency and session expiry survive a process restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'identity-launcher-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path); const launch = { id: randomUUID(), subject: 'alice', requestID: randomUUID(), state: 'bootstrapping' };
  store.insert(launch); store.saveSession('session', { subject: 'alice' }, Date.now() + 60000); store.saveSession('expired', {}, Date.now() - 1); store.close();
  store = new Store(path); t.after(() => store.close());
  assert.deepEqual(store.find('alice', launch.requestID), launch);
  assert.equal(store.session('session').subject, 'alice'); assert.equal(store.session('expired'), undefined);
});
