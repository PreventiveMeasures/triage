import { createHash } from 'node:crypto'
import type { ManagedConfig } from './config.ts'
import type { SelectedRepo } from './db.ts'
import { GithubApiError, type GithubIdentity, READ_PERMISSIONS, githubJson, githubRepoPermission, githubUserIdentity, onTokenRejected, repoAccessToken } from './github-app.ts'
import { MAX_PACKAGE_BYTES, readConfigEntryPoints, readPackageEntryPoints } from './package-entry-points.ts'
import { MAX_STASIS_CONFIG_BYTES, STASIS_CONFIG } from './stasis-config.ts'
import { readSolidityEntryPoints } from './solidity-entry-points.ts'
import { parseGithubCommit } from './bundle-commits.ts'
import { appDependabotAlerts } from './dependabot-access.ts'

const REFS_PAGE = 100

// Each branch or tag GitHub lists, by its name and commit, those it names
// one for.
const refCommits = (items: { name?: unknown; commit?: { sha?: unknown } }[]) => items.flatMap(item => typeof item?.name === 'string' && item.name
  && typeof item.commit?.sha === 'string' && /^[a-f\d]{40}$/u.test(item.commit.sha) ? [{ name: item.name, sha: item.commit.sha }] : [])

// Each branch GitHub lists, by its name and commit. Branches are listed by
// name, a full page of them leaving the default branch out where many come
// before it: its commit is read apart then, by its ref, none where that fails.
async function branchCommits(read: (suffix: string) => Promise<unknown>, branches: { name?: unknown; commit?: { sha?: unknown } }[], defaultBranch: string) {
  const listed = refCommits(branches)
  if (!defaultBranch || branches.length < REFS_PAGE || listed.some(item => item.name === defaultBranch)) return listed
  const ref = await read(`/git/ref/heads/${defaultBranch.split('/').map(encodeURIComponent).join('/')}`).catch(() => null) as { object?: { sha?: unknown } } | null
  return typeof ref?.object?.sha === 'string' && /^[a-f\d]{40}$/u.test(ref.object.sha) ? [...listed, { name: defaultBranch, sha: ref.object.sha }] : listed
}

export interface RepositoryEntry { name: string; path: string; type: 'dir' | 'file' | 'symlink' | 'submodule' }

// Restricted managers can walk the ancestors of their grants, without seeing
// sibling names or files outside those grants. null means the entire repo.
export function scopedDirectory(path: string, scopes: (string | null)[]): RepositoryEntry[] | null {
  if (scopes.some(scope => !scope || path === scope || path.startsWith(scope + '/'))) return null
  const prefix = path ? path + '/' : ''
  const names = new Set(scopes.filter((scope): scope is string => !!scope && scope.startsWith(prefix)).map(scope => scope.slice(prefix.length).split('/')[0]!))
  return [...names].toSorted().map(name => ({ name, path: prefix + name, type: 'dir' }))
}

export interface RepositoryBrowserUser { githubUserId: number | null; token: string | null }

function credentialFailure(err: unknown): err is GithubApiError {
  return err instanceof GithubApiError && ([401, 404].includes(err.status) || err.message === 'github-status-403')
}

// GitHub's answer on a user's access to a repository, as checkAccess reads it:
// the repository's metadata, which credential reads it (the user's token, the
// App installation's, or none, as for a public repository read anonymously)
// and the permission level GitHub told, where it was asked. Kept per user, by
// their GitHub id and token, and per repository, by its id, name and
// installation, for config.repositoryAccessCacheMs; only access granted is kept.
// One answered for a user with a token is kept no longer once GitHub rejects
// that token (`userToken`, hashed), whichever credential reads it: a private
// repository's was granted on who that token told GitHub they are. The next
// check asks GitHub, falling back to the installation's or none as it does.
type RepoMetadata = { id?: unknown; full_name?: unknown; private?: unknown; visibility?: unknown; default_branch?: unknown }
type AccessVerdict = { until: number; data: RepoMetadata; credential: 'user' | 'app' | 'none'; level: string | null; userToken: string | null }
type VerdictCache = { get(): AccessVerdict | undefined; set(verdict: Omit<AccessVerdict, 'until' | 'userToken'>): void }
const MAX_ACCESS_VERDICTS = 1000
// By the fetch reading GitHub, as installation tokens are: a test's own.
const accessVerdicts = new WeakMap<typeof fetch, Map<string, AccessVerdict>>()
const hashed = (token: string) => createHash('sha256').update(token).digest('hex')
onTokenRejected((token, fetchImpl) => {
  const kept = accessVerdicts.get(fetchImpl)
  if (!kept) return
  const rejected = hashed(token)
  for (const [key, verdict] of kept) if (verdict.userToken === rejected) kept.delete(key)
})

function verdictCache(config: ManagedConfig, user: RepositoryBrowserUser, repo: SelectedRepo, fetchImpl: typeof fetch): VerdictCache | null {
  const keepMs = config.repositoryAccessCacheMs
  if (!(keepMs > 0)) return null
  let verdicts = accessVerdicts.get(fetchImpl)
  if (!verdicts) { verdicts = new Map(); accessVerdicts.set(fetchImpl, verdicts) }
  const kept = verdicts
  // The token hashed with the rest, never kept as it is.
  const key = createHash('sha256').update(JSON.stringify([user.githubUserId, user.token, repo.repoId, repo.fullName.toLowerCase(), repo.installationId, config.githubAppId])).digest('hex')
  return {
    get() {
      const verdict = kept.get(key)
      if (verdict && verdict.until > Date.now()) return verdict
      kept.delete(key)
      return undefined
    },
    set(verdict) {
      kept.delete(key)
      kept.set(key, { ...verdict, until: Date.now() + keepMs, userToken: user.token ? hashed(user.token) : null })
      while (kept.size > MAX_ACCESS_VERDICTS) kept.delete(kept.keys().next().value!)
    },
  }
}

// Create once per HTTP request. Coalesce concurrent credential lookups, and
// keep GitHub's answer on each user's access to each repository a while
// (verdictCache), never sharing credentials or answers across users.
export function createRepositoryBrowser(config: ManagedConfig, user: RepositoryBrowserUser, fetchImpl: typeof fetch = globalThis.fetch) {
  const tokens = new Map<number, Promise<string | null>>()
  let identity: Promise<GithubIdentity> | undefined
  // The user as GitHub tells them, asked once a request.
  const getIdentity = (): Promise<GithubIdentity> => {
    if (!user.token || user.githubUserId == null) return Promise.reject(new GithubApiError(404, 'no-repository'))
    if (!identity) {
      identity = githubUserIdentity(user.token, fetchImpl).then(value => {
        if (value.id !== user.githubUserId) throw new GithubApiError(404, 'no-repository')
        return value
      })
    }
    return identity
  }
  return {
    reader(repo: SelectedRepo) {
      const installationToken = () => {
        if (repo.installationId == null) return Promise.resolve(null)
        const cached = tokens.get(repo.installationId)
        const token = cached ?? repoAccessToken(config, repo.installationId, fetchImpl).catch((err: unknown) => {
          if (!credentialFailure(err)) throw err
          // Stale installations cannot prevent verified public access.
          return null
        })
        if (!cached) tokens.set(repo.installationId, token)
        return token
      }
      // Its Dependabot alerts, with the token of the installation GitHub tells
      // covers it, where the user's own access lets them see them
      // (dependabot-access.ts).
      return repositoryReader(repo, user.token, installationToken, getIdentity, fetchImpl, verdictCache(config, user, repo, fetchImpl)).then(reader => ({ ...reader,
        dependabotAlerts: () => appDependabotAlerts(config, repo, { identity: getIdentity, permission: reader.permission }, fetchImpl) }))
    },
  }
}

// The files of the tree `tree` (its id) of the repository `fullName`, and of
// every tree under it, as GitHub lists them at once with `token`, a reader's
// (readToken): how many and their bytes, or null where GitHub cuts the
// listing short, as it does past 100,000 entries.
export async function repositoryTreeFiles(fullName: string, token: string | null, tree: string, fetchImpl: typeof fetch = globalThis.fetch) {
  if (!/^[a-f\d]{40}$/u.test(tree)) throw new GithubApiError(400, 'bad-tree')
  const url = `https://api.github.com/repos/${fullName.split('/').map(encodeURIComponent).join('/')}/git/trees/${tree}?recursive=1`
  const data = await githubJson(url, token, fetchImpl) as { tree?: unknown; truncated?: unknown }
  if (!Array.isArray(data?.tree)) throw new GithubApiError(502, 'github-malformed')
  if (data.truncated === true) return null
  let bytes = 0, files = 0
  for (const item of data.tree as { type?: unknown; size?: unknown }[]) {
    if (item?.type !== 'blob') continue
    files++
    if (typeof item.size === 'number' && item.size > 0) bytes += item.size
  }
  return { files, bytes }
}

type Access = { data: RepoMetadata; token: string | null; level: string | null }

// GitHub asked whether the user may read `repo`: its metadata, read with
// `token` (the reader's credential so far), else the installation's, else
// none; and of one not public, the user's permission, read with the
// installation's. What it told, the token reading it, and the level asked.
async function askAccess(repo: SelectedRepo, start: string | null, userToken: string | null, installationToken: () => Promise<string | null>,
  getIdentity: () => Promise<GithubIdentity>, fetchImpl: typeof fetch): Promise<Access> {
  const base = `https://api.github.com/repos/${repo.fullName.split('/').map(encodeURIComponent).join('/')}`
  let token = start
  const metadata = async () => {
    try { return await githubJson(base, token, fetchImpl) }
    catch (err) {
      if (!token || !credentialFailure(err)) throw err
      const fallback = await installationToken()
      if (fallback && fallback !== token) {
        token = fallback
        try { return await githubJson(base, token, fetchImpl) } catch (fallbackError) { if (!credentialFailure(fallbackError)) throw fallbackError }
      }
      // Anonymous fallback is only for unavailable credentials, never rate
      // limits, network errors, or GitHub outages.
      token = null
      return githubJson(base, token, fetchImpl)
    }
  }
  // A repository last known private asks who the user is, and mints the
  // installation token its permission is asked with, as it asks for its
  // metadata, not after. Each is asked once a request (the token once for
  // concurrent requests too, github-app.ts), so a failure is answered where
  // it is awaited. One made public since mints a token it never waits for,
  // kept for later requests.
  if (repo.private && userToken) {
    getIdentity().catch(() => {})
    if (repo.installationId != null) installationToken().catch(() => {})
  }
  // Stored visibility can be stale (or internal with private=false). Require
  // current, explicit public visibility or the caller's effective permission.
  const data = await metadata() as RepoMetadata
  if (data?.id !== repo.repoId || typeof data.full_name !== 'string' || data.full_name.toLowerCase() !== repo.fullName.toLowerCase()) {
    throw new GithubApiError(404, 'no-repository')
  }
  if (data.private === false && data.visibility === 'public') return { data, token, level: null }
  if (!token) throw new GithubApiError(404, 'no-repository')
  const appToken = await installationToken()
  if (!appToken) throw new GithubApiError(404, 'no-repository')
  const level = await githubRepoPermission(repo.fullName, appToken, await getIdentity(), fetchImpl)
  if (!READ_PERMISSIONS.has(level)) throw new GithubApiError(404, 'no-repository')
  return { data, token: appToken, level }
}

// GitHub's answer as kept (verdictCache), with the credential it chose,
// where that credential is still had; else asked (`ask`), and kept where it
// grants access.
async function keptAccess(verdicts: VerdictCache | null, userToken: string | null, installationToken: () => Promise<string | null>,
  ask: () => Promise<Access>): Promise<Access> {
  const kept = verdicts?.get()
  if (kept) {
    const credential = kept.credential === 'user' ? userToken : kept.credential === 'app' ? await installationToken() : null
    if (kept.credential === 'none' || credential) return { data: kept.data, token: credential, level: kept.level }
  }
  const asked = await ask()
  const { id, full_name, private: hidden, visibility, default_branch } = asked.data
  const data = { id, full_name, private: hidden, visibility, default_branch }
  verdicts?.set({ data, credential: asked.token === null ? 'none' : asked.token === userToken ? 'user' : 'app', level: asked.level })
  return { ...asked, data }
}

async function repositoryReader(repo: SelectedRepo, userToken: string | null, installationToken: () => Promise<string | null>, getIdentity: (fresh?: boolean) => Promise<GithubIdentity>, fetchImpl: typeof fetch,
  verdicts: VerdictCache | null) {
  const base = `https://api.github.com/repos/${repo.fullName.split('/').map(encodeURIComponent).join('/')}`
  // Public reads can use the signed-in user's quota without repository grants.
  // Nonpublic reads still require the repository App and the effective-user gate,
  // whose permission level is kept (`level`).
  let level: string | null = null, token = userToken ?? await installationToken()
  const read = (suffix: string) => githubJson(base + suffix, token, fetchImpl)
  const checkAccess = async (): Promise<RepoMetadata> => {
    const access = await keptAccess(verdicts, userToken, installationToken, () => askAccess(repo, token, userToken, installationToken, getIdentity, fetchImpl))
    token = access.token
    level = access.level
    return access.data
  }
  const current = await checkAccess()
  const defaultBranch = typeof current.default_branch === 'string' ? current.default_branch : ''
  return {
    // Its visibility and the user's permission asked again, the user as
    // GitHub told them earlier in the request, not asked again.
    recheckAccess: () => checkAccess(),
    // Server-only credential, selected by the same live visibility/permission
    // gate as directory browsing. Never included in an HTTP response.
    readToken: () => token,
    // The user's permission level on it where the gate asked GitHub of it, as
    // for a private repository; null for a public one.
    permission: () => level,
    // Its default branch as GitHub named it when access was first checked,
    // `''` where it named none: the one whose head `commit('')` reads.
    defaultBranch,
    async refs() {
      // Suggestions are bounded; the input also accepts any branch or tag name.
      const list = async (kind: string) => {
        const data = await read(`/${kind}?per_page=${REFS_PAGE}`)
        if (!Array.isArray(data)) throw new GithubApiError(502, 'github-malformed')
        return data
      }
      const [branches, tags] = await Promise.all([list('branches'), list('tags')])
      const names = (items: { name?: unknown }[]) => items.flatMap(item => typeof item?.name === 'string' ? [item.name] : [])
      // Each branch's and tag's commit, for the code viewer's header to name a
      // commit by, and each tag's for the tag cache. A full page may leave
      // tags out; only a shorter one lists every tag.
      return { defaultBranch, branches: names(branches), tags: names(tags), branchCommits: await branchCommits(read, branches, defaultBranch),
        tagCommits: refCommits(tags), tagsComplete: tags.length < REFS_PAGE }
    },
    async commit(ref: string) {
      if (/^[a-f\d]{40}$/iu.test(ref)) return ref
      const data = await read(`/commits/${encodeURIComponent(ref || (defaultBranch ? `heads/${defaultBranch}` : 'HEAD'))}`) as { sha?: unknown }
      if (typeof data?.sha !== 'string' || !/^[a-f\d]{40}$/iu.test(data.sha)) throw new GithubApiError(502, 'github-malformed')
      return data.sha
    },
    // The first commit a listing from `sha` returns is that commit, without
    // the files GET /commits/:sha adds.
    async commitDetails(sha: string) {
      return /^[a-f\d]{40}$/u.test(sha) ? parseGithubCommit(sha, await read(`/commits?sha=${sha}&per_page=1`)) : null
    },
    async directory(path: string, commit: string) {
      const data = await read(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(commit)}`)
      if (!Array.isArray(data)) throw new GithubApiError(400, 'not-a-directory')
      const entries: RepositoryEntry[] = []
      for (const item of data) {
        if (typeof item?.name !== 'string' || item.name.includes('/') || item.name === '.' || item.name === '..') continue
        const expectedPath = path ? `${path}/${item.name}` : item.name
        if (item.path !== expectedPath) continue
        const type = item.submodule_git_url ? 'submodule' : item.type
        if (['dir', 'file', 'symlink', 'submodule'].includes(type)) entries.push({ name: item.name, path: expectedPath, type })
      }
      const listed = (name: string, maxBytes: number) => data.find(item => item?.path === (path ? `${path}/${name}` : name) && item.name === name
        && item.type === 'file' && !item.submodule_git_url && typeof item.size === 'number' && item.size >= 0 && item.size <= maxBytes
        && typeof item.sha === 'string' && /^[a-f\d]{40}$/iu.test(item.sha))
      // The entries stasis.config.json lists are suggested before any guess:
      // a build takes them alone, with their options there.
      const config = listed(STASIS_CONFIG, MAX_STASIS_CONFIG_BYTES)
      const configEntryPoints = config ? await readConfigEntryPoints(config.sha, path, read) : []
      if (configEntryPoints.length > 0) return { entries, limited: data.length >= 1000, configEntryPoints }
      const manifest = listed('package.json', MAX_PACKAGE_BYTES)
      // Both optional suggestions, read together: neither fails, each
      // answering none where its reads do.
      const [packageEntryPoints, solidity] = await Promise.all([manifest ? readPackageEntryPoints(manifest.sha, path, read) : undefined,
        readSolidityEntryPoints(path, data, read)])
      return { entries, limited: data.length >= 1000, ...(packageEntryPoints ? { packageEntryPoints } : {}),
        ...(solidity.paths.length > 0 || solidity.limited ? { solidityEntryPoints: solidity.paths, soliditySuggestionsLimited: solidity.limited } : {}),
      }
    },
  }
}
