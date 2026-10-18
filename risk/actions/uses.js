// What a `uses:` names, as GitHub reads it (`owner/repo[/path]@ref`, `./path`,
// `$/path`, `docker://image`), and an image a job runs in.

const GITHUB_OWNERS = new Set(['actions', 'github'])

const OWNER = /^[\da-z](?:[\da-z]|-(?=[\da-z])){0,38}$/iu
const NAME = /^(?!\.{1,2}$)[\w.-]{1,100}$/u
const SHA = /^[\da-f]{40}$/u
const SHORT_SHA = /^[\da-f]{7,39}$/u
// A version a comment beside a pin names, as Dependabot, Renovate, pinact
// and ratchet write one (`# v4.1.1`, `# tag=v4.1.1`, `# ratchet:x@v4`).
const VERSION_COMMENT = /^#\s*(?:tag\s*[=:]\s*|pin@|ratchet:[^\s@]+@)?(v?\d+(?:\.\d+){0,3}(?:[-+][\w.-]+)?)(?![\w.])/iu

// `sha`, `short-sha`, `ref` (a tag or a branch), or `expression`, which GitHub refuses.
function pinOf(ref) {
  if (/\$\{\{/u.test(ref)) return 'expression'
  if (SHA.test(ref)) return 'sha'
  return SHORT_SHA.test(ref) ? 'short-sha' : 'ref'
}

// An image's name, tag and digest (`[host[:port]/]path[:tag][@digest]`), null
// for none; null where it isn't one.
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

const commentVersion = comment => typeof comment === 'string' ? VERSION_COMMENT.exec(comment.trim())?.[1] ?? null : null

export const isWorkflowPath = path => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path)

// `{ kind, uses, … }`: `action`, or `workflow` at a job's level (`job`), with
// its `repo`, `path`, `ref`, `pin` and `comment`'s version; `local`, `self`
// at the commit running, `job` a reusable workflow's, at the calling
// workflow's commit; `docker`; or `invalid`, which GitHub won't run.
export function readUses(text, { job = false, comment = null } = {}) {
  const uses = typeof text === 'string' ? text.trim() : ''
  if (uses.startsWith('./') || uses.startsWith('$/')) {
    return { kind: 'local', uses, path: uses.slice(2).replace(/\/+$/u, ''), ...uses.startsWith('$/') ? { self: true } : {}, ...job ? { job: true } : {} }
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

// The key a reference is resolved once by, a commit's with its comment's version.
export const usesKey = ({ repo, path, ref, pin, comment }) => `${repo.toLowerCase()}${path ? `/${path}` : ''}@${ref}${pin === 'sha' && comment ? ` # ${comment}` : ''}`

// A reference from its key, a reusable workflow's by its path's.
export function usesOfKey(key) {
  const m = typeof key === 'string' ? /^([^@\s]+@\S+)(?: # (\S+))?$/u.exec(key) : null
  const job = Boolean(m && /^[^/]+\/[^/]+\/\.github\/workflows\/[^/@]+\.ya?ml@/u.test(m[1]))
  const read = m ? readUses(m[1], { job, comment: m[2] ? `# ${m[2]}` : null }) : null
  return read && (read.kind === 'action' || read.kind === 'workflow') && usesKey(read) === key ? read : null
}

// GitHub's own, the workflow's owner's, or another's.
export function ownerKind(repo, owner) {
  const of = repo.split('/')[0].toLowerCase()
  if (GITHUB_OWNERS.has(of)) return 'github'
  return typeof owner === 'string' && of === owner.toLowerCase() ? 'own' : 'third-party'
}
