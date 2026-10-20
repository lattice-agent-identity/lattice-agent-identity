#!/bin/sh
set -eu
if [ "$1" = provisionerd ]; then
  export LATTICE_PROVISIONER_DAEMON_KEY="$(cat /run/secrets/provisioner_key)"
fi
exec /opt/lattice "$@"
