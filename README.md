# Lattice Agent Identity

An authenticated workspace launcher backed by the Workstations and Identity forks pinned in this repository's submodules. Launch signs a controller into Identity, creates a human-owned template workspace, enrolls an agent identity, and waits for workspace connectivity and agent authentication before offering **Open workspace**.

This is a server application, not a static site. The former Firebase Hosting configuration has been removed. Do not publish the repository root with a static file server.

## Credentials and ownership

1. The launcher uses OIDC authorization code flow with PKCE, state and nonce. Only subjects explicitly mapped in `LAUNCH_CONTROLLERS` can launch.
2. A server-side Management API M2M application creates the agent with that human as controller. A Workstations admin token creates the workspace owned by the mapped human.
3. The workspace generates and persists an Ed25519 private key locally. Only its public key and signed proof go to Identity through a short-lived, single-key bootstrap capability.
4. The launcher approves the identity and Workstations service grant, creates a dedicated service account with workspace-creation prohibited, and grants it `use` access to this workspace.
5. The runtime signs an Identity assertion, exchanges its JWT for a Workstations API key valid for at most five minutes, refreshes it, and proves readiness using that key.

The key, enrollment configuration, refreshed credentials and runtime log live in `/home/node/.agent-identity` with private permissions. Agent programs can read `credentials.json` and must reload it after expiration. The template starts the identity runtime; it does not install or start an LLM agent application. Add your agent process to a reviewed template/image.

## Hosting

The deployment targets one Linux amd64 host and a **dedicated rootless Docker engine**. Caddy terminates HTTPS for four DNS names. Backend and database ports are not published. Workspaces run as an unprivileged user with dropped capabilities, no privilege escalation, CPU/memory/process limits and no Docker socket. Only the external provisioner receives the dedicated rootless socket.

Rootless containers are not a hard boundary against hostile workloads or kernel exploits. Use a dedicated VM/host, restrict launch access, and configure firewall/outbound policy for your threat model. This single-replica deployment does not provide HA or a multi-tenant isolation guarantee.

The template's `nproc` limit is a shared UID process budget, not a per-container cgroup PID limit. Reserve capacity across workspaces and enforce stricter workload isolation outside this template when required.

### Build

Install Go 1.26, Node.js 24, pnpm 10.33.2, Docker Compose v2, curl, unzip and zstd on Linux amd64. Configure a dedicated rootless Docker context. Build images in the same engine the provisioner will use. Allow sufficient build memory; avoid concurrent memory-heavy development servers.

```bash
git clone --recurse-submodules https://github.com/lattice-agent-identity/lattice-agent-identity.git
cd lattice-agent-identity
bash deploy/build.sh
cp .env.example .env
chmod 600 .env
mkdir -p .local/secrets
chmod 700 .local .local/secrets
```

The build script builds the frontend/release binary, verifies Terraform checksums, tests/builds the vendored Lattice provider, and builds all four images. The rebranded provider is vendored because the required registry package is unpublished. Its MPL license and source are included. The vendored Pixel Storybook package retains its MIT license.

### Configure

Keep `.env` and `.local` private and out of Git. Replace every placeholder. Use independent random hexadecimal database passwords, for example `openssl rand -hex 32`. Never reuse development credentials. Management and admin credentials are privileged: dedicate accounts/apps to this service, audit usage, protect and rotate their secrets.

Create four DNS records pointing at the host. Allow HTTPS and HTTP certificate issuance, arranging rootless port 80/443 forwarding according to host policy. The following IDs/secrets are installation-specific. Compose validates required variables even when starting only a subset, so initially supply temporary nonempty client/template IDs, replacing them before starting the launcher.

1. Set hostnames/passwords, then start and seed Identity:

   ```bash
   docker compose up -d identity-db
   docker compose --profile setup run --rm identity-setup
   docker compose up -d identity gateway
   ```

   Open the configured Identity admin hostname and complete initial administrator setup. Restrict that hostname with a firewall or access proxy. Configure stable HTTPS endpoints before creating clients.

2. Create two Identity **Traditional web** applications. Workstations needs redirect URI `https://WORKSTATIONS_HOST/api/v2/users/oidc/callback`; supply its `WORKSTATIONS_OIDC_*` values. The launcher needs `https://APP_HOST/auth/callback`; supply `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`. Allow the scopes configured in Compose. Human Workstations login needs a verified email claim.

3. Create a dedicated M2M application with a Management API role granting `all` access to the deployment's exact Management API resource. Set `IDENTITY_MANAGEMENT_*`. This is a server credential, never a browser credential. The OpenAgent Identity feature is already enabled in Compose.

4. Start Workstations with `docker compose up -d workstations`. Complete first-user setup and configure the organization. Sign each authorized human into Workstations using Identity. Map their Identity subject to their Workstations user UUID in the `LAUNCH_CONTROLLERS` JSON object. Each must be an active, non-service organization user. Do not map humans to a shared admin account.

5. Enable per-user sharing for human-owned workspaces in that organization (`shareable_workspace_owners=everyone`, global sharing not disabled). The launcher assigns a specific agent ACL, not public access. Set `WORKSTATIONS_ORGANIZATION_ID`. Create a dedicated Workstations admin API token and an organization-scoped provisioner key, **not** a deployment-wide PSK. Store them in the configured secret files. The launcher runs as container UID 1000, so file-backed Compose secrets need UID-compatible read access. Use mode `0444` on the individual files inside the host's `0700` secret directory, or equivalent UID-mapped ACLs. Other host users must not be able to traverse that directory.

6. Run `docker compose up -d provisioner`. Import `deploy/template` using the Workstations template UI or `lattice templates push`, selecting Terraform, and wait for successful import. The provisioner includes its provider mirror. Set `WORKSTATIONS_TEMPLATE_ID` to the template UUID, not the version UUID. The workspace image must exist in the engine behind `WORKSPACE_DOCKER_SOCKET`.

7. Validate and start:

   ```bash
   bash deploy/check.sh
   docker compose up -d
   docker compose ps
   docker compose logs --tail=100 launcher provisioner
   ```

   Do not admit users until acceptance checks pass. The Workstations public URL, Identity Workstations audience and token resource must be the same canonical HTTPS origin. The OIDC issuer must be the canonical Identity HTTPS URL plus `/oidc`.

### Acceptance and operations

- In a fresh browser, Launch must require Identity login and reject unmapped users.
- Launch once. Verify a human-owned workspace, a distinct human-controlled agent with verified public key, approved Workstations grant, and dedicated service account with creation-ban role.
- Wait for Open workspace and confirm its agent is connected. Inspect runtime logs and credential permissions without printing secrets. The runtime credential must read the assigned workspace but fail to create another workspace.
- Reload/retry: the same request must not duplicate resources. Restart the workspace: it must reuse the persisted key and refresh credentials after five minutes.
- Suspend the agent in Identity: new issuance must fail. Existing Workstations keys expire within five minutes. Delete test workspaces through Workstations; the next launcher status check frees their quota slot. Deleting a workspace alone does not revoke its Identity principal.

Back up both PostgreSQL databases, launcher SQLite (using its backup API, or stopping the launcher to preserve WAL consistency), Caddy state and workspace home volumes. Protect backups as secrets and test restoration. Losing an agent's home volume requires fresh enrollment; no server-side private-key copy exists.

Run only one launcher replica: SQLite storage and creation/bootstrap locks are single-process. Failed workspaces count toward quota until deleted. Bootstrap expires after 15 minutes; fix startup failures and create a new launch rather than reusing expired parameters. Set quotas suitable for the host. Revoke grants/suspend identities when retiring agents, and clean up service accounts/volumes through supported admin flows. Never run `docker compose down -v` unless destruction of persistent data is intended.

Rotate client, M2M, admin and provisioner secrets and recreate affected services. Production Compose enforces HTTPS; do not enable development HTTP or Identity development Management API headers on a hosted instance.

## Checks and local development

```bash
npm ci
npm test
npm run check
node --test workstations/scripts/agent-runtime.test.mjs
docker compose --env-file .env.example config --quiet
```

For local development, set `NODE_ENV=development`, provide the variables validated by `server/config.mjs`, and run `npm start`. `APP_URL` is the browser origin; `LAUNCHER_RUNTIME_URL` can be a different network-reachable origin for workspace containers. The launcher still uses real OAuth M2M credentials for its Management API calls.
