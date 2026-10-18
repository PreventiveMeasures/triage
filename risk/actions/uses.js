// What a `uses:` names, as GitHub reads it: an action or a reusable
// workflow of a repository on GitHub (`owner/repo[/path]@ref`), one of the
// repository's own, in the workspace (`./path`) or at the commit running
// (`$/path`, since July 2026), or a Docker image (`docker://image`); and the
// image a job's `container:` or `services:` names. An action's ref is its
// pin: a full commit sha, which no push changes, or else a tag or a branch,
// which its repository's owner can point anywhere, and a short sha, which
// GitHub reads as one too where one is named so.

// GitHub's own, whose actions a workflow's runner ships with too.
const GITHUB_OWNERS = new Set(['actions', 'github'])

const OWNER = /^[\da-z](?:[\da-z]|-(?=[\da-z])){0,38}$/iu
const NAME = /^(?!\.{1,2}$)[\w.-]{1,100}$/u
const SHA = /^[\da-f]{40}$/u
const SHORT_SHA = /^[\da-f]{7,39}$/u
// A version a comment beside a pin names, as Dependabot, Renovate, pinact
// and ratchet write one: `# v4.1.1`, `# tag=v4.1.1`, `# pin@v4`,
// `# ratchet:actions/checkout@v4`.
const VERSION_COMMENT = /^#\s*(?:tag\s*[=:]\s*|pin@|ratchet:[^\s@]+@)?(v?\d+(?:\.\d+){0,3}(?:[-+][\w.-]+)?)(?![\w.])/iu

// How a ref pins what it names: `sha`, `short-sha` or `ref` (a tag or a
// branch), and `expression` for one an expression names, which GitHub
// refuses.
function pinOf(ref) {
  if (/\$\{\{/u.test(ref)) return 'expression'
  if (SHA.test(ref)) return 'sha'
  return SHORT_SHA.test(ref) ? 'short-sha' : 'ref'
}

// An image as Docker names it, `[host[:port]/]path[:tag][@digest]`: its
// name, tag and digest, null where it hasn't one; null where it isn't one,
// or an expression names it.
export function readImage(text) {
  if (typeof text !== 'string' || text === '' || /\$\{\{|\s/u.test(text)) return null
  const at = text.indexOf('@')
  const digest = at === -1 ? null : text.slice(at + 1)
  const named = at === -1 ? text : text.slice(0, at)
  const colon = named.lastIndexOf(':')
  const tagged = colon > named.lastIndexOf('/')
  if (digest !== null && !/^sha256:[\da-f]{64}$/u.test(digest)) return null
  return { image: tagged ? named.slice(0, colon) : named, tag: tagged ? named.slice(colon + 1) : null, digest }
}

// The version a comment beside a `uses:` names, or null.
const commentVersion = comment => typeof comment === 'string' ? VERSION_COMMENT.exec(comment.trim())?.[1] ?? null : null

// Whether a path in a repository is a workflow's, as a reusable one is named.
export const isWorkflowPath = path => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path)

// What `uses` names (`text`): `{ kind, uses, … }`, its kind `action`, or
// `workflow` at a job's level (`job`), with its `repo`, `path` in it ('' for
// its root), `ref` and `pin`, and the version a `comment` beside it names;
// `local`, with its `path`, `self` where it is at the commit running;
// `docker`, with its image; or `invalid`, for what GitHub wouldn't run.
export function readUses(text, { job = false, comment = null } = {}) {
  const uses = typeof text === 'string' ? text.trim() : ''
  if (uses.startsWith('./') || uses.startsWith('$/')) {
    return { kind: 'local', uses, path: uses.slice(2).replace(/\/+$/u, ''), ...uses.startsWith('$/') ? { self: true } : {} }
  }
  if (uses.startsWith('docker://')) {
    const image = job ? null : readImage(uses.slice('docker://'.length))
    return image ? { kind: 'docker', uses, ...image } : { kind: 'invalid', uses }
  }
  const at = uses.indexOf('@')
  const [owner = '', name = '', ...path] = (at === -1 ? uses : uses.slice(0, at)).split('/')
  const ref = at === -1 ? '' : uses.slice(at + 1)
  if (!OWNER.test(owner) || !NAME.test(name) || ref === '' || path.some(part => !NAME.test(part)) || (job && !isWorkflowPath(path.join('/')))) {
    return { kind: 'invalid', uses }
  }
  return { kind: job ? 'workflow' : 'action', uses, repo: `${owner}/${name}`, path: path.join('/'), ref, pin: pinOf(ref), comment: commentVersion(comment) }
}

// The key a reference is resolved once by: its repository, as GitHub names
// are, in any case, its path and its ref, and for a commit, the version a
// comment beside it names, which the commit is held to.
export const usesKey = ({ repo, path, ref, pin, comment }) => `${repo.toLowerCase()}${path ? `/${path}` : ''}@${ref}${pin === 'sha' && comment ? ` # ${comment}` : ''}`

// A reference from its key (usesKey), as resolving one is asked by key: a
// reusable workflow's by its path, a workflow file's, as no action's is.
export function usesOfKey(key) {
  const m = typeof key === 'string' ? /^([^@\s]+@[^\s#]+)(?: # (\S+))?$/u.exec(key) : null
  const job = Boolean(m && /^[^/]+\/[^/]+\/\.github\/workflows\/[^/@]+\.ya?ml@/u.test(m[1]))
  const read = m ? readUses(m[1], { job, comment: m[2] ? `# ${m[2]}` : null }) : null
  return read && (read.kind === 'action' || read.kind === 'workflow') && usesKey(read) === key ? read : null
}

// Whose a repository is, beside the one a workflow is of (`owner`): GitHub's
// own, the same owner's, or another's.
export function ownerKind(repo, owner) {
  const of = repo.split('/')[0].toLowerCase()
  if (GITHUB_OWNERS.has(of)) return 'github'
  return typeof owner === 'string' && of === owner.toLowerCase() ? 'own' : 'third-party'
}
