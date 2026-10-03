#!/bin/sh
set -eu

LOCK_PATH=${PASSHUB_MAINTENANCE_LOCK_PATH:-/run/passhub/maintenance/controller.lock}
RUNTIME_DIR=${PASSHUB_MAINTENANCE_RUNTIME_DIR:-/run/passhub/maintenance}
LOCK_PARENT=$(dirname "$LOCK_PATH")
test -d "$LOCK_PARENT" && test ! -L "$LOCK_PARENT"
test -d "$RUNTIME_DIR" && test ! -L "$RUNTIME_DIR"
# The descriptor stays open for the complete controller process.  Nonblocking
# flock makes a concurrent manual/timer invocation fail without waiting.
exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  printf '%s\n' 'G11E_CONTROLLER_BUSY' >&2
  exit 75
fi
exec node "$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)/scripts/g11/maintenance-controller.mjs"
