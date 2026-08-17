#!/usr/bin/env bash
# Guided setup for a new schuit-sharing deployment. Thin launcher --
# the actual logic lives in scripts/quickstart.mjs (one implementation,
# used from both this and quickstart.ps1, since hand-rolling JSON
# generation twice in two shell dialects is a bad idea).
#
# See README.md for what this automates (and, more importantly, what it
# deliberately doesn't) -- this is a convenience wrapper around README.md's
# numbered steps, not a replacement for reading them.

set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH. See README.md \"Prereqs\"." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/scripts/quickstart.mjs" "$@"
