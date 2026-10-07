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

# SessionStart stdout is added to Claude's context, so the nvm, corepack
# and pnpm logs (a full install lists every package) go to stderr. Only
# the closing summary line is written to the original stdout, kept on fd 3.
exec 3>&1 1>&2

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR" || abort "cannot cd to $PROJECT_DIR"

# Read the hook input now, but parse it only once Node is set up: in an
# nvm-only shell there is no node on PATH before that.
HOOK_INPUT=""
if [ ! -t 0 ]; then
  HOOK_INPUT="$(cat)"
fi

# Load nvm into this non-login shell.
export NVM_DIR="${NVM_DIR:-/opt/nvm}"
have_nvm=1
# shellcheck disable=SC1091
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh"
elif [ -s /etc/profile.d/nvm.sh ]; then
  . /etc/profile.d/nvm.sh
else
  have_nvm=0
  warn "nvm not found (checked \$NVM_DIR=$NVM_DIR, \$HOME/.nvm, /etc/profile.d/nvm.sh); trying node $(node --version 2>/dev/null || echo 'none') from PATH"
fi

# Switch to the Node version .nvmrc in the current directory pins, and
# point NODE_BIN at its bin dir.
setup_node() {
  if [ "$have_nvm" -eq 1 ]; then
    # `nvm install` (no args) reads .nvmrc from the project root. The
    # download hits nodejs.org and is the most likely failure point at
    # session start, so retry transient blips before giving up. Three
    # attempts cover the common case without dragging the session out.
    local attempt install_ok=0
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
    NODE_BIN="$(dirname "$(nvm which current)")" || abort "nvm which current failed"
  else
    # Without nvm, carry on with the Node on PATH when it satisfies
    # package.json's engines.node, so the session still gets its
    # dependencies installed. pnpm only warns on an engines mismatch, so
    # refuse it here. .nvmrc pins the preferred version, not the floor,
    # so it only stands in when engines.node is missing or uses more
    # than `>=` and `<` comparators, joined by spaces and `||`.
    local wanted
    if ! wanted="$(node -e '
      let range = ""
      try { range = require("./package.json").engines?.node ?? "" } catch {}
      const parse = (v) => v.replace(/^v/, "").split(".").map(Number)
      const cmp = (a, b) => [0, 1, 2].reduce((d, i) => d || (a[i] || 0) - (b[i] || 0), 0)
      const have = parse(process.version)
      const sets = range.split("||").map((set) => set.trim().split(/\s+/).map((c) => /^(>=|<)v?(\d+(?:\.\d+){0,2})$/.exec(c)))
      if (range.trim() && sets.flat().every(Boolean)) {
        console.log(`engines.node ${range} from package.json`)
        process.exitCode = sets.some((set) => set.every(([, op, v]) => (cmp(have, parse(v)) >= 0) === (op === ">="))) ? 0 : 1
      } else {
        console.log(`${process.argv[1] || "<missing>"} from .nvmrc`)
        process.exitCode = cmp(have, parse(process.argv[1])) < 0 ? 1 : 0
      }
    ' "$(cat .nvmrc 2>/dev/null)")"; then
      abort "node $(node --version 2>/dev/null || echo 'none') on PATH doesn't satisfy ${wanted:-the required version}"
    fi
    NODE_BIN="$(dirname "$(command -v node)")"
  fi
}
setup_node

# CLAUDE_PROJECT_DIR stays at the checkout the session started in, while
# the hook input's cwd follows Claude into a worktree. Set that worktree
# up instead when it belongs to the same repository, so it doesn't come
# up without node_modules, and set up Node again there, as its .nvmrc
# may pin another version. Another repo, a non-git cwd or no input keep
# the project dir.
HOOK_CWD="$(printf '%s' "$HOOK_INPUT" | node -e 'try { process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).cwd ?? "") } catch {}' || true)"
git_common_dir() { git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null; }
if [ -n "$HOOK_CWD" ] && WORKTREE="$(git -C "$HOOK_CWD" rev-parse --show-toplevel 2>/dev/null)" &&
  [ "$WORKTREE" != "$(pwd -P)" ] &&
  [ "$(git_common_dir "$WORKTREE")" = "$(git_common_dir "$PROJECT_DIR")" ]; then
  PROJECT_DIR="$WORKTREE"
  cd "$PROJECT_DIR" || abort "cannot cd to $PROJECT_DIR"
  setup_node
fi

# Put a directory first on PATH, here and for the rest of the session,
# so subsequent tool calls (npm test, tsc, etc.) don't fall back to
# system Node. The Claude Code harness sources $CLAUDE_ENV_FILE before
# every tool call; without it set, the export only lives inside this
# script's own shell and the next Bash tool call resets to system
# Node — log loudly so the regression is visible rather than silent.
prepend_path() {
  export PATH="$1:$PATH"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$1:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  fi
}
prepend_path "$NODE_BIN"
if [ -z "${CLAUDE_ENV_FILE:-}" ]; then
  warn "CLAUDE_ENV_FILE unset; node $(node --version) will not persist across tool calls"
fi

# Enable corepack so the pnpm version pinned in package.json's
# `packageManager` field is the one that actually runs. Node builds
# without corepack (Node 25+ no longer bundles it), or a corepack that
# can't write its shims next to a root-owned Node, get that same version
# from npm instead, in a prefix of the hook's own: npm's global prefix
# may be root-owned too, or have its bin dir off PATH. Each pinned
# version gets its own prefix, left alone once installed, since sessions
# sharing $HOME may pin different versions and each keeps the one its
# persisted PATH points at. Non-fatal — a stale system pnpm still mostly
# works.
#
# Installs $1 into the prefix $2 unless it is already there. npm writes
# into a temporary prefix renamed into place, so concurrent hooks never
# share a half-written one; when another hook's rename wins, it is used.
install_pnpm() {
  local tmp
  [ -x "$2/bin/pnpm" ] && return 0
  mkdir -p "$(dirname "$2")" && tmp="$(mktemp -d "$2.XXXXXX")" || return 1
  if npm install -g --prefix "$tmp" "$1"; then
    mv -T "$tmp" "$2" 2>/dev/null || rm -rf "$tmp"
  else
    rm -rf "$tmp"
  fi
  [ -x "$2/bin/pnpm" ]
}
pnpm_ready=0
if command -v corepack >/dev/null 2>&1; then
  if corepack enable --install-directory "$NODE_BIN"; then
    pnpm_ready=1
  else
    warn "corepack enable failed; installing pnpm with npm instead"
  fi
fi
if [ "$pnpm_ready" -ne 1 ]; then
  pnpm_prefix=""
  if pnpm_spec="$(node -p 'require("./package.json").packageManager.split("+")[0]')" &&
    pnpm_prefix="${XDG_CACHE_HOME:-$HOME/.cache}/session-start/$pnpm_spec" &&
    install_pnpm "$pnpm_spec" "$pnpm_prefix"; then
    prepend_path "$pnpm_prefix/bin"
  else
    warn "npm install -g --prefix ${pnpm_prefix:-<none>} ${pnpm_spec:-pnpm} failed; pnpm pinning may not apply"
  fi
fi

# `pnpm ci` semantics: install exactly what's in pnpm-lock.yaml, fail
# if it would need to be updated.
pnpm install --frozen-lockfile || abort "pnpm install --frozen-lockfile failed"

echo "session-start: ready in $PROJECT_DIR: node $(node --version), pnpm $(pnpm --version)" >&3
