import { readFileSync } from 'node:fs';

export function readConfig(env = process.env) {
  const production = env.NODE_ENV !== 'development';
  function required(name) {
    const value = env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`], 'utf8').trim() : env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  }
  function url(name) {
    const result = new URL(required(name));
    if (result.username || result.password || result.search || result.hash || result.pathname !== '/') throw new Error(`${name} must be an origin`);
    if (result.protocol !== 'https:' && !(env.NODE_ENV === 'development' && result.protocol === 'http:')) throw new Error(`${name} requires HTTPS`);
    return result.origin;
  }
  const controllers = JSON.parse(required('LAUNCH_CONTROLLERS'));
  if (!controllers || Array.isArray(controllers) || !Object.keys(controllers).length || Object.entries(controllers).some(([subject, id]) => !/^[A-Za-z0-9_-]{1,21}$/.test(subject) || !/^[a-f0-9-]{36}$/i.test(id))) throw new Error('LAUNCH_CONTROLLERS must map Identity subjects to Workstations user UUIDs');
  const config = {
    production, appURL: url('APP_URL'), identityURL: url('IDENTITY_URL'), workstationsURL: url('WORKSTATIONS_URL'),
    runtimeURL: env.LAUNCHER_RUNTIME_URL ? url('LAUNCHER_RUNTIME_URL') : url('APP_URL'),
    clientID: required('OIDC_CLIENT_ID'), clientSecret: required('OIDC_CLIENT_SECRET'),
    managementClientID: required('IDENTITY_MANAGEMENT_CLIENT_ID'), managementClientSecret: required('IDENTITY_MANAGEMENT_CLIENT_SECRET'),
    managementResource: required('IDENTITY_MANAGEMENT_RESOURCE'), workstationsToken: required('WORKSTATIONS_ADMIN_TOKEN'),
    organizationID: required('WORKSTATIONS_ORGANIZATION_ID'), templateID: required('WORKSTATIONS_TEMPLATE_ID'),
    controllers, database: env.LAUNCHER_DATABASE || '/data/launcher.sqlite', port: Number(env.PORT || 8090),
    maxWorkspaces: Number(env.MAX_WORKSPACES_PER_CONTROLLER || 3), bootstrapTTL: 15 * 60_000,
  };
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535 || !Number.isSafeInteger(config.maxWorkspaces) || config.maxWorkspaces < 1) throw new Error('Invalid port or workspace limit');
  return config;
}
