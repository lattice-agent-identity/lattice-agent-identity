export class ServiceError extends Error {
  constructor(service, path, status) { super(`${service} ${path}: HTTP ${status}`); this.status = status; }
}

export function services(config, fetcher = fetch) {
  let management;
  let discovery;
  async function json(service, url, method = 'GET', body, headers = {}) {
    const form = body instanceof URLSearchParams;
    const response = await fetcher(url, { method, headers: { ...(!form ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : form ? body : JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (!response.ok) throw new ServiceError(service, new URL(url).pathname, response.status);
    return response.status === 204 ? undefined : response.json();
  }
  async function metadata() {
    discovery ??= await json('Identity', `${config.identityURL}/oidc/.well-known/openid-configuration`);
    if (discovery.issuer !== `${config.identityURL}/oidc` || new URL(discovery.token_endpoint).origin !== config.identityURL) throw new Error('Unexpected Identity issuer');
    return discovery;
  }
  async function identity(path, method, body) {
    if (!management || management.expires < Date.now() + 60_000) {
      const token = await json('Identity', (await metadata()).token_endpoint, 'POST', new URLSearchParams({ grant_type: 'client_credentials', client_id: config.managementClientID, client_secret: config.managementClientSecret, resource: config.managementResource, scope: 'all' }));
      management = { token: token.access_token, expires: Date.now() + token.expires_in * 1000 };
    }
    return json('Identity', `${config.identityURL}/api${path}`, method, body, { Authorization: `Bearer ${management.token}` });
  }
  async function workstations(path, method, body, token = config.workstationsToken) {
    return json('Workstations', `${config.workstationsURL}/api/v2${path}`, method, body, { 'Lattice-Session-Token': token });
  }
  return { identity, workstations, metadata };
}
