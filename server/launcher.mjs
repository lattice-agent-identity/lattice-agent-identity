import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const hash = value => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export function equal(a, b) { if (typeof a !== 'string' || typeof b !== 'string') return false; const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }

export function publicKey(jwk) {
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x) || Object.keys(jwk).some(key => !['kty', 'crv', 'x', 'alg', 'use'].includes(key))) throw new HttpError(400, 'An Ed25519 public key is required');
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x, alg: 'EdDSA', use: 'sig' };
}

export class Launcher {
  constructor(config, store, api) { this.config = config; this.store = store; this.api = api; this.running = new Map(); }
  async locked(id, operation) {
    const before = this.running.get(id) || Promise.resolve();
    const task = before.catch(() => {}).then(operation).finally(() => { if (this.running.get(id) === task) this.running.delete(id); });
    this.running.set(id, task); return task;
  }
  authorized(subject) {
    if (!Object.hasOwn(this.config.controllers, subject)) throw new HttpError(403, 'This Identity user is not authorized to launch workspaces');
    return this.config.controllers[subject];
  }
  owned(subject, id) {
    this.authorized(subject);
    const launch = this.store.get(id);
    if (!launch || launch.subject !== subject) throw new HttpError(404, 'Launch not found');
    return launch;
  }
  async status(subject, id) {
    const launch = this.owned(subject, id);
    if (!['ready', 'deleted'].includes(launch.state) && Date.now() > launch.expires) { launch.state = 'failed'; launch.error = 'Agent bootstrap timed out. Check the workspace startup logs.'; this.store.save(launch); }
    if (launch.workspaceID) {
      try {
        const workspace = await this.api.workstations(`/workspaces/${launch.workspaceID}`);
        launch.workspaceStatus = workspace.latest_build.status;
        const connected = workspace.latest_build.resources?.some(resource => resource.agents?.some(agent => agent.status === 'connected' && agent.lifecycle_state === 'ready'));
        if (launch.machineReady && launch.workspaceStatus === 'running' && connected) launch.state = 'ready';
        else if (launch.state === 'ready') launch.state = 'unavailable';
        if (['failed', 'canceled'].includes(workspace.latest_build.status)) { launch.state = 'failed'; launch.error = 'Workspace build failed. Inspect its build logs in Workstations.'; }
        if (launch.state !== 'ready' && Date.now() > launch.expires) { launch.state = 'failed'; launch.error = 'Agent bootstrap timed out. Check the workspace startup logs.'; }
        this.store.save(launch);
      } catch (error) { if (error.status === 404) { launch.state = 'deleted'; this.store.save(launch); } else throw error; }
    }
    return this.view(launch);
  }
  view(launch) {
    return { id: launch.id, state: launch.state, agentID: launch.agentID, workspaceStatus: launch.workspaceStatus, workspaceURL: launch.workspaceURL, error: launch.error };
  }
  async launch(subject, requestID) {
    const ownerID = this.authorized(subject);
    if (!/^[a-f0-9-]{36}$/i.test(requestID || '')) throw new HttpError(400, 'A UUID requestId is required');
    return this.locked(`launch:${subject}`, async () => {
      const prior = this.store.find(subject, requestID);
      if (prior) return this.view(prior);
      const launches = this.store.list(subject);
      for (const old of launches.filter(row => row.workspaceID && row.state !== 'deleted')) await this.status(subject, old.id);
      if (this.store.list(subject).filter(row => row.workspaceID && row.state !== 'deleted').length >= this.config.maxWorkspaces) throw new HttpError(409, 'Workspace limit reached. Delete an existing workspace in Workstations before launching another.');
      const template = await this.api.workstations(`/templates/${this.config.templateID}`);
      if (template.organization_id !== this.config.organizationID) throw new HttpError(503, 'The launch template is not in the configured organization');
      const sharing = await this.api.workstations(`/organizations/${this.config.organizationID}/settings/workspace-sharing`);
      if (sharing.sharing_globally_disabled || sharing.shareable_workspace_owners !== 'everyone') throw new HttpError(503, 'Enable per-user workspace sharing for human-owned workspaces in this organization');
      const owner = await this.api.workstations(`/users/${ownerID}`);
      const organizations = await this.api.workstations(`/users/${ownerID}/organizations`);
      if (owner.status !== 'active' || owner.is_service_account || !organizations.some(org => org.id === this.config.organizationID)) throw new HttpError(403, 'The configured workspace owner must be an active organization user');
      const controller = await this.api.identity(`/users/${subject}`);
      if (controller.isSuspended) throw new HttpError(403, 'This Identity controller is suspended');
      const id = randomUUID();
      const bootstrap = secret();
      const launch = { id, subject, requestID, ownerID, name: `identity-${id.slice(0, 8)}`, state: 'creating', bootstrapHash: hash(bootstrap), expires: Date.now() + this.config.bootstrapTTL };
      this.store.insert(launch);
      try {
        const identity = await this.api.identity('/agent-identities', 'POST', { name: launch.name, email: `launch-${id}@agents.invalid`, customData: { launchID: id, organizationID: this.config.organizationID }, controller: { type: 'user', entityId: subject } });
        launch.agentID = identity.principal.id; this.store.save(launch);
        const workspace = await this.api.workstations(`/users/${ownerID}/workspaces`, 'POST', {
          name: launch.name, template_id: this.config.templateID,
          rich_parameter_values: [
            { name: 'identity_bootstrap_token', value: bootstrap },
            { name: 'identity_launch_id', value: id },
            { name: 'identity_launcher_url', value: this.config.runtimeURL || this.config.appURL },
          ],
        });
        launch.workspaceID = workspace.id;
        launch.workspaceURL = `${this.config.workstationsURL}/@${encodeURIComponent(owner.username)}/${launch.name}`;
        launch.state = 'bootstrapping'; this.store.save(launch);
        return this.view(launch);
      } catch (error) {
        launch.state = 'failed'; launch.error = 'Provisioning failed. Ask the administrator to inspect the launcher service logs.'; this.store.save(launch);
        if (launch.agentID) await this.api.identity(`/agent-identities/${launch.agentID}/suspend`, 'POST', {}).catch(() => {});
        console.error(`Launch ${id}: ${error.message}`);
        throw new HttpError(502, launch.error);
      }
    });
  }
  bootstrap(id, token) {
    const launch = this.store.get(id);
    if (!launch || typeof token !== 'string' || !equal(launch.bootstrapHash, hash(token)) || launch.expires < Date.now() || launch.state === 'failed') throw new HttpError(401, 'Invalid or expired bootstrap credential');
    this.authorized(launch.subject);
    if (!launch.workspaceID) throw new HttpError(409, 'Workspace is not assigned yet; retry shortly');
    return launch;
  }
  async challenge(id, token, inputJwk) {
    const jwk = publicKey(inputJwk);
    return this.locked(`bootstrap:${id}`, async () => {
      const launch = this.bootstrap(id, token);
      if (launch.challenge) {
        if (!equal(launch.jwk.x, jwk.x)) throw new HttpError(409, 'Bootstrap is already bound to another key');
        return { challengeId: launch.challenge.challengeId, nonce: launch.challenge.nonce };
      }
      launch.challenge = await this.api.identity(`/agent-identities/${launch.agentID}/key-challenges`, 'POST', { algorithm: 'EdDSA', publicJwk: jwk, runtimeInstance: { runtime: 'other', externalInstanceId: `workspace:${launch.workspaceID}` } });
      launch.jwk = jwk; this.store.save(launch);
      return { challengeId: launch.challenge.challengeId, nonce: launch.challenge.nonce };
    });
  }
  async verify(id, token, { nonce, signature }) {
    return this.locked(`bootstrap:${id}`, async () => {
      const launch = this.bootstrap(id, token);
      if (!launch.challenge || !equal(nonce, launch.challenge.nonce) || typeof signature !== 'string' || signature.length > 128 || !verify(null, Buffer.from(`openagent-challenge:${launch.challenge.challengeId}:${nonce}`), createPublicKey({ key: launch.jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))) throw new HttpError(401, 'Invalid key proof');
      const configuration = () => ({ agentID: launch.agentID, userID: launch.agentUserID, workspaceID: launch.workspaceID, identityURL: this.config.identityURL, workstationsURL: this.config.workstationsURL, launchID: id, launcherURL: this.config.runtimeURL || this.config.appURL });
      if (launch.used) return configuration();
      if (!launch.proofVerified) {
        await this.api.identity(`/agent-identities/${launch.agentID}/key-challenges/${launch.challenge.challengeId}/verify`, 'POST', { nonce, signature });
        launch.proofVerified = true; this.store.save(launch);
      }
      await this.api.identity(`/agent-identities/${launch.agentID}/approve`, 'POST', {});
      const metadata = await this.api.metadata();
      const username = `oa-${hash(`${metadata.issuer}\n${launch.agentID}`).slice(0, 28)}`;
      if (!launch.agentUserID) {
        let user;
        try { user = await this.api.workstations('/users', 'POST', { username, name: launch.name, service_account: true, login_type: 'none', user_status: 'active', organization_ids: [this.config.organizationID] }); }
        catch (error) {
          if (error.status !== 409) throw error;
          const response = await this.api.workstations(`/users?q=${encodeURIComponent(`username:${username}`)}`);
          user = response.users?.find(candidate => candidate.username === username && candidate.is_service_account && candidate.status === 'active');
          if (!user) throw error;
        }
        launch.agentUserID = user.id; this.store.save(launch);
      }
      await this.api.workstations(`/organizations/${this.config.organizationID}/members/${launch.agentUserID}/roles`, 'PUT', { roles: ['organization-workspace-creation-ban'] });
      const security = await this.api.identity(`/agent-identities/${launch.agentID}/security`);
      if (!security.grants.some(grant => grant.service === 'workstations' && grant.status === 'approved')) {
        await this.api.identity(`/agent-identities/${launch.agentID}/service-grants`, 'POST', { service: 'workstations', scopes: ['workstations:access'] });
        await this.api.identity(`/agent-identities/${launch.agentID}/service-grants/workstations/approve`, 'POST', {});
      }
      await this.api.workstations(`/workspaces/${launch.workspaceID}/acl`, 'PATCH', { user_roles: { [launch.agentUserID]: 'use' } });
      launch.used = true; launch.state = 'authenticating'; this.store.save(launch);
      return configuration();
    });
  }
  async ready(id, token) {
    const launch = this.store.get(id);
    if (!launch || !launch.used || !token) throw new HttpError(401, 'Agent authentication required');
    const me = await this.api.workstations('/users/me', 'GET', undefined, token);
    if (me.id !== launch.agentUserID || !me.is_service_account || me.status !== 'active') throw new HttpError(403, 'Wrong agent account');
    this.authorized(launch.subject);
    launch.machineReady = true; this.store.save(launch);
    return { ready: true };
  }
}
