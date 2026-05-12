#!/bin/bash
# Drop -e so a transient failure (typically `nvm install` failing to
# download the tarball) doesn't kill the script silently and leave the
# session falling back to system Node without a visible reason. Each
# step below is checked explicitly and emits a clear message before
# either retrying, warning, or aborting.
set -uo pipefail

log() { echo "session-start: $*" >&2; }
abort() { log "ERROR: $*"; exit 1; }
warn() { log "WARN: $*"; }

# Only run inside Claude Code on the web. Locally the developer's shell
# already manages Node via nvm/asdf/etc.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Load nvm into this non-login shell.
export NVM_DIR="${NVM_DIR:-/opt/nvm}"
# shellcheck disable=SC1091
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh"
elif [ -s /etc/profile.d/nvm.sh ]; then
  . /etc/profile.d/nvm.sh
else
  abort "nvm not found (checked \$NVM_DIR=$NVM_DIR, \$HOME/.nvm, /etc/profile.d/nvm.sh)"
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

# `nvm install` (no args) reads .nvmrc from the project root. The
# download hits nodejs.org and is the most likely failure point at
# session start, so retry transient blips before giving up. Three
# attempts cover the common case without dragging the session out.
install_ok=0
for attempt in 1 2 3; do
  if nvm install; then
    install_ok=1
    break
  fi
  warn "nvm install attempt $attempt failed; retrying"
  sleep $((attempt * 2))
done
if [ "$install_ok" -ne 1 ]; then
  abort "nvm install failed after 3 attempts; .nvmrc=$(cat .nvmrc 2>/dev/null || echo '<missing>'). Tools will run on whatever node is on PATH ($(node --version 2>/dev/null || echo 'none'))."
fi

nvm use || abort "nvm use failed after install (.nvmrc=$(cat .nvmrc 2>/dev/null || echo '<missing>'))"

# Persist Node on PATH for the rest of the session so subsequent
# tool calls (npm test, tsc, etc.) don't fall back to system Node.
# The Claude Code harness sources $CLAUDE_ENV_FILE before every tool
# call; without it set, the export below only lives inside this
# script's own shell and the next Bash tool call resets to system
# Node — log loudly so the regression is visible rather than silent.
NODE_BIN="$(dirname "$(nvm which current)")" || abort "nvm which current failed"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$NODE_BIN:\$PATH\"" >> "$CLAUDE_ENV_FILE"
else
  warn "CLAUDE_ENV_FILE unset; node $(node --version) will not persist across tool calls"
fi
export PATH="$NODE_BIN:$PATH"

# Enable corepack so the pnpm version pinned in package.json's
# `packageManager` field is the one that actually runs. Non-fatal —
# a stale system pnpm still mostly works.
corepack enable || warn "corepack enable failed; pnpm pinning may not apply"

# `pnpm ci` semantics: install exactly what's in pnpm-lock.yaml, fail
# if it would need to be updated.
pnpm install --frozen-lockfile || abort "pnpm install --frozen-lockfile failed"

log "ready: node $(node --version), pnpm $(pnpm --version)"
