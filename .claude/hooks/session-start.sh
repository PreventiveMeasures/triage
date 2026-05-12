#!/bin/bash
set -euo pipefail

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
  echo "session-start: nvm not found" >&2
  exit 1
fi

# `nvm install` (no args) reads .nvmrc from the project root.
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"
nvm install
nvm use

# Persist Node 24 on PATH for the rest of the session so subsequent
# tool calls (npm test, tsc, etc.) don't fall back to system Node 22.
NODE_BIN="$(dirname "$(nvm which current)")"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$NODE_BIN:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
export PATH="$NODE_BIN:$PATH"

# Enable corepack so the pnpm version pinned in package.json's
# `packageManager` field is the one that actually runs.
corepack enable

# `pnpm ci` semantics: install exactly what's in pnpm-lock.yaml, fail
# if it would need to be updated.
pnpm install --frozen-lockfile
