#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test -f .env || { echo 'Create .env using .env.example first.' >&2; exit 1; }
docker compose config --quiet
if grep -Eq 'replace-with|replace-identity-sub|00000000-0000-0000-0000-' .env; then
  echo 'Replace all example credentials, IDs, and controller mappings before hosting.' >&2
  exit 1
fi
if ! docker info --format '{{json .SecurityOptions}}' | grep -q rootless; then
  echo 'Run the deployment with a dedicated rootless Docker engine, not the rootful host daemon.' >&2
  exit 1
fi
# Resolve interpolation without evaluating the .env file as shell code.
workspace_socket=$(docker compose config --format json | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const c=JSON.parse(s);console.log(c.services.provisioner.volumes.find(v=>v.target==='/var/run/docker.sock').source)})")
if ! docker --host "unix://$workspace_socket" info --format '{{json .SecurityOptions}}' | grep -q rootless; then
  echo 'WORKSPACE_DOCKER_SOCKET must also point to a rootless engine.' >&2
  exit 1
fi
docker compose run --rm --no-deps launcher node -e "import('./server/config.mjs').then(m=>m.readConfig())"
echo 'Deployment configuration passed. Verify DNS, TLS, backups and image qualification before accepting users.'
