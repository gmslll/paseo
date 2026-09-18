#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
ELECTRON="$REPO_ROOT/node_modules/.bin/electron"

exec "$ELECTRON" "$SCRIPT_DIR/main.js" "$@"
