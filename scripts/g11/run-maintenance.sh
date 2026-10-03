#!/bin/sh
set -eu

LOCK_PATH=${PASSHUB_MAINTENANCE_LOCK_PATH:-/run/passhub/maintenance/controller.lock}
RUNTIME_DIR=${PASSHUB_MAINTENANCE_RUNTIME_DIR:-/run/passhub/maintenance}
RESET_RESULT_FILE=${PASSHUB_RESET_RESULT_FILE:-/var/lib/passhub/maintenance/reset-result.json}
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
if [ -f "$RESET_RESULT_FILE" ]; then
  export PASSHUB_RESET_RESULT_FILE="$RESET_RESULT_FILE"
  node "$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)/scripts/g11/publish-dataset-epoch.mjs"
fi
exec node "$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)/scripts/g11/maintenance-controller.mjs"
