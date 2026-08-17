# Guided setup for a new schuit-sharing deployment. Thin launcher --
# the actual logic lives in scripts/quickstart.mjs (one implementation,
# used from both this and quickstart.sh, since hand-rolling JSON
# generation twice in two shell dialects is a bad idea).
#
# See README.md for what this automates (and, more importantly, what it
# deliberately doesn't) -- this is a convenience wrapper around README.md's
# numbered steps, not a replacement for reading them.

$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "node not found on PATH. See README.md `"Requirements`"."
    exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node "$ScriptDir\scripts\quickstart.mjs" @args
exit $LASTEXITCODE
