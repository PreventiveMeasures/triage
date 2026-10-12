// Where npm installs a dependency from, read off its spec as npm-package-arg
// reads one: the registry (a version, a range, a tag, an `npm:` alias), a
// path, a repository on a host npm knows, a git URL or a tarball's.

// The hosts npm takes a repository on (hosted-git-info, which npm-package-arg
// reads a spec with): by name (`github:owner/repo`), or by its domain over
// the protocols each takes, where its path names a repository, `[user,
// project, committish]`, and not a tarball or a file.
const trim = project => project?.replace(/\.git$/u, '')
const GIT_HOSTS = new Map([
  ['github', { label: 'GitHub', domain: 'github.com', protocols: ['git:', 'http:', 'git+ssh:', 'git+https:', 'ssh:', 'https:'], repo({ pathname, hash }) {
    const [, user, project, type, committish] = pathname.split('/', 5)
    return (!type || type === 'tree') && user && trim(project) ? [user, trim(project), type ? committish : hash.slice(1)] : null
  } }],
  ['bitbucket', { label: 'Bitbucket', domain: 'bitbucket.org', protocols: ['git+ssh:', 'git+https:', 'ssh:', 'https:'], repo({ pathname, hash }) {
    const [, user, project, aux] = pathname.split('/', 4)
    return aux !== 'get' && user && trim(project) ? [user, trim(project), hash.slice(1)] : null
  } }],
  ['gitlab', { label: 'GitLab', domain: 'gitlab.com', protocols: ['git+ssh:', 'git+https:', 'ssh:', 'https:'], repo({ pathname, hash }) {
    const path = pathname.slice(1)
    const at = path.lastIndexOf('/')
    if (path.includes('/-/') || path.includes('/archive.tar.gz')) return null
    return path.slice(0, Math.max(at, 0)) && trim(path.slice(at + 1)) ? [path.slice(0, at), trim(path.slice(at + 1)), hash.slice(1)] : null
  } }],
  ['gist', { label: 'Gist', domain: 'gist.github.com', protocols: ['git:', 'git+ssh:', 'git+https:', 'ssh:', 'https:'], repo({ pathname, hash }) {
    const [, user, project, aux] = pathname.split('/', 4)
    return aux !== 'raw' && (user || project) ? [project ? user : null, trim(project || user), hash.slice(1)] : null
  } }],
  ['sourcehut', { label: 'SourceHut', domain: 'git.sr.ht', protocols: ['git+ssh:', 'https:'], repo({ pathname, hash }) {
    const [, user, project, aux] = pathname.split('/', 4)
    return aux !== 'archive' && user && trim(project) ? [user, trim(project), hash.slice(1)] : null
  } }],
])
const BY_DOMAIN = new Map([...GIT_HOSTS.values()].map(host => [host.domain, host]))
// The protocols hosted-git-info reads a URL by as it is, the hosts' names too.
const PROTOCOLS = new Set(['git+ssh:', 'ssh:', 'git+https:', 'git:', 'http:', 'https:', 'git+http:', ...[...GIT_HOSTS.keys()].map(name => `${name}:`)])

// GitHub's `owner/repo` shorthand, before a commit, branch or tag
// (`#v1.0.0`) or not, as hosted-git-info tells it: a slash, not first, nor
// last before any `#`; no `.` first; and no space, `@`, `:` or second slash
// before any `#`.
function githubShorthand(spec) {
  const hash = spec.indexOf('#'), slash = spec.indexOf('/')
  const beforeHash = at => at > -1 && !(hash > -1 && at > hash)
  return slash > 0 && !spec.startsWith('.') && (hash > -1 ? spec[hash - 1] !== '/' : !spec.endsWith('/'))
    && ![/\s/u.exec(spec)?.index ?? -1, spec.indexOf('@'), spec.indexOf(':'), spec.indexOf('/', slash + 1)].some(beforeHash)
}

// A URL as hosted-git-info parses one: a protocol it doesn't know put
// before a `git@host:path` (as `git+ssh://`) or given its `//`, and else
// `host:path` read as `host/path`.
const safeUrl = text => { try { return new URL(text) } catch { return null } }
function hostedUrl(spec) {
  const at = spec.indexOf('@'), colon = spec.indexOf(':')
  const corrected = PROTOCOLS.has(spec.slice(0, colon + 1)) || at > -1 && at < colon ? spec : at > -1 ? `git+ssh://${spec}`
    : spec.indexOf('//') === colon + 1 ? spec : `${spec.slice(0, colon + 1)}//${spec.slice(colon + 1)}`
  if (safeUrl(corrected)) return safeUrl(corrected)
  const before = char => { const hash = corrected.indexOf('#'); return corrected.lastIndexOf(char, hash > -1 ? hash : Infinity) }
  let scp = before(':') > before('@') ? `${corrected.slice(0, before(':'))}/${corrected.slice(before(':') + 1)}` : corrected
  if (scp.lastIndexOf(':', scp.indexOf('#') > -1 ? scp.indexOf('#') : Infinity) === -1 && !scp.includes('//')) scp = `git+ssh://${scp}`
  return safeUrl(scp)
}

// The host npm takes a spec's repository on (hosted-git-info's fromUrl), or
// null: one by its name, whatever its path, or by its domain over a protocol
// it takes, where its path names a repository; none whose parts don't
// decode.
function gitHost(spec) {
  if (!spec) return null
  const url = hostedUrl(githubShorthand(spec) ? `github:${spec}` : spec)
  if (!url) return null
  const named = GIT_HOSTS.get(url.protocol.slice(0, -1))
  const host = named ?? BY_DOMAIN.get(url.hostname.replace(/^www\./u, ''))
  const parts = named ? [url.pathname.replace(/^\/?[^@]*@|^\//u, ''), url.hash.slice(1)] : host?.protocols.includes(url.protocol) && host.repo(url)
  try { return parts ? (parts.forEach(part => part && decodeURIComponent(part)), host) : null } catch { return null }
}

// Where npm installs a dependency's spec from, read once in
// npm-package-arg's resolve order: `path` for a path (`./x`, `~/x`, `/x`,
// `c:/x`, `file:`); `registry` for an `npm:` alias of a registry package,
// or a spec with no `/` or `:` that names no tarball, which no later step
// takes; a repository on a host npm knows (gitHost), named for it
// (`GitHub`); for a URL, `git` for a repository's (`git:`, `git+https:`,
// `git+ssh:`, `git+http:`, `git+rsync:`, `git+ftp:`, `git+file:`, and
// `git+ssh://` to `user@host:path`), `URL` for a tarball's (`https:`,
// `http:`), and null for one npm doesn't install (`workspace:`, `ssh:` on
// another host); then `path` again for one with a `/` or a tarball's name
// (`a/b/c`, `x.tgz`, `git@example.com:x/y`), and else `registry`: a
// version, a range or a tag.
function specFrom(spec) {
  const value = String(spec ?? '').trim()
  if (/^(?:[.]|~\/|\/|[a-z]:|file:)/iu.test(value)) return 'path'
  if (/^npm:/iu.test(value) || !/[/:]|[.](?:tgz|tar\.gz|tar)$/iu.test(value)) return 'registry'
  const host = gitHost(value)
  if (host) return host.label
  if (/^(?:git\+)?[a-z]+:/iu.test(value)) {
    const scp = /^git\+ssh:\/\/([^:#]+:[^#]+(?:\.git)?)(?:#.*)?$/iu.exec(value)
    if (value.startsWith('git+ssh:') && scp && !/:\d+(?:\/|$)/u.test(scp[1])) return 'git'
    const protocol = safeUrl(value)?.protocol
    return /^(?:git|git\+(?:https?|rsync|ftp|file|ssh)):$/u.test(protocol) ? 'git' : /^https?:$/u.test(protocol) ? 'URL' : null
  }
  return /\/|[.](?:tgz|tar\.gz|tar)$/iu.test(value) ? 'path' : 'registry'
}

// Where a dependency's spec has npm fetch it from, where that isn't its
// registry (specFrom): a host's name (`GitHub`), `git` or `URL`. Null for
// the registry's ranges and tags, a path, and what npm doesn't install.
export function npmDependencySource(spec) {
  const from = specFrom(spec)
  return from === 'registry' || from === 'path' ? null : from
}

// The package and spec an `npm:` alias names (`npm:pkg@^1.2.3`), as
// specFrom reads one; null for a spec that isn't one.
export function npmAlias(spec) {
  const [, name, range = ''] = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@(.*))?$/iu.exec(String(spec ?? '').trim()) ?? []
  return name ? { name, spec: range } : null
}

// Whether npm installs a dependency's spec from its registry (specFrom):
// not from a path, a repository or a URL, nor a scheme npm doesn't install
// (`workspace:`), the registry's package of that name being what npm
// installs for none of those.
export const npmRegistrySpec = spec => specFrom(spec) === 'registry'
