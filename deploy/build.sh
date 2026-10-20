#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for command in go node pnpm docker curl unzip zstd sha256sum; do command -v "$command" >/dev/null; done
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo 'The hosted workspace image currently targets Linux amd64.' >&2
  exit 1
fi
mkdir -p deploy/artifacts

# Use the committed generated sources; producing a release does not regenerate Go APIs.
pnpm --dir workstations/site install --frozen-lockfile
pnpm --dir workstations/site build
(
  cd workstations
  ./scripts/build_go.sh --slim --os linux --arch amd64 --output build/hosted/lattice-linux-amd64
  mkdir -p site/out/bin
  cp build/hosted/lattice-linux-amd64 site/out/bin/lattice-linux-amd64
  (cd site/out/bin && sha1sum --binary lattice-linux-amd64 > lattice.sha1 && tar -cf - lattice-linux-amd64 | zstd -6 -T2 -f -o lattice.tar.zst)
  ./scripts/build_go.sh --os linux --arch amd64 --output ../deploy/artifacts/lattice
)
if ! echo '0d17011f0c4664539b164b044903d04e296c86c13cb9f28040076c65cfb3985a  deploy/artifacts/terraform.zip' | sha256sum --check --strict --status; then
  curl --fail --silent --show-error --location --connect-timeout 20 --max-time 300 --retry 2 https://releases.hashicorp.com/terraform/1.16.2/terraform_1.16.2_linux_amd64.zip -o deploy/artifacts/terraform.zip
fi
echo '0d17011f0c4664539b164b044903d04e296c86c13cb9f28040076c65cfb3985a  deploy/artifacts/terraform.zip' | sha256sum --check --strict
unzip -o deploy/artifacts/terraform.zip terraform -d deploy/artifacts
echo '7d9946a5d2e4d2f37d0f9f95678a21af2c260bca37b494f38f04aa89ddae8b43  deploy/artifacts/terraform' | sha256sum --check --strict
(
  cd workstations/deploy/provisioner/provider-source
  TF_ACC_TERRAFORM_PATH="$(pwd)/../../../../deploy/artifacts/terraform" go test ./provider/...
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o ../../../../deploy/artifacts/terraform-provider-lattice_v2.33.6 .
)
docker build -f deploy/Dockerfile.workstations -t lattice-workstations:local .
docker build -f deploy/Dockerfile.workspace -t lattice-identity-workspace:local .
docker build -f deploy/Dockerfile.launcher -t lattice-launcher:local .
docker build --build-arg openagent_identity_enabled=true -t lattice-identity:local identity
