#!/bin/bash
set -euo pipefail

install -m 0400 -o mongodb -g mongodb /run/secrets/mongo_root_username /tmp/passhub-mongo-root-username
install -m 0400 -o mongodb -g mongodb /run/secrets/mongo_root_password /tmp/passhub-mongo-root-password
install -m 0400 -o mongodb -g mongodb /run/secrets/mongo_keyfile /tmp/passhub-mongo-keyfile
export MONGO_INITDB_ROOT_USERNAME_FILE=/tmp/passhub-mongo-root-username
export MONGO_INITDB_ROOT_PASSWORD_FILE=/tmp/passhub-mongo-root-password
exec /usr/local/bin/docker-entrypoint.sh "$@" --auth --keyFile /tmp/passhub-mongo-keyfile
