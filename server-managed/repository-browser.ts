import type { ManagedConfig } from './config.ts'
import type { SelectedRepo } from './db.ts'
import { GithubApiError, githubJson, githubRepoReadPermission, githubUserIdentity, repoAccessToken } from './github-app.ts'
import { MAX_PACKAGE_BYTES, readPackageEntryPoints } from './package-entry-points.ts'
import { readSolidityEntryPoints } from './solidity-entry-points.ts'
import { parseGithubCommit } from './bundle-commits.ts'

const REFS_PAGE = 100

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
type GithubIdentity = Awaited<ReturnType<typeof githubUserIdentity>>

function credentialFailure(err: unknown): err is GithubApiError {
  return err instanceof GithubApiError && ([401, 404].includes(err.status) || err.message === 'github-status-403')
}

// Create once per HTTP request. Coalesce concurrent credential lookups without
// caching repository visibility or permissions, or sharing credentials across users.
export function createRepositoryBrowser(config: ManagedConfig, user: RepositoryBrowserUser, fetchImpl: typeof fetch = globalThis.fetch) {
  const tokens = new Map<number, Promise<string | null>>()
  let identity: Promise<GithubIdentity> | undefined
  const getIdentity = (fresh = false): Promise<GithubIdentity> => {
    if (!user.token || user.githubUserId == null) return Promise.reject(new GithubApiError(404, 'no-repository'))
    if (!identity || fresh) {
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
      return repositoryReader(repo, user.token, installationToken, getIdentity, fetchImpl)
    },
  }
}

async function repositoryReader(repo: SelectedRepo, userToken: string | null, installationToken: () => Promise<string | null>, getIdentity: (fresh?: boolean) => Promise<GithubIdentity>, fetchImpl: typeof fetch) {
  const base = `https://api.github.com/repos/${repo.fullName.split('/').map(encodeURIComponent).join('/')}`
  // Public reads can use the signed-in user's quota without repository grants.
  // Nonpublic reads still require the repository App and the effective-user gate.
  let token = userToken ?? await installationToken()
  const read = (suffix: string) => githubJson(base + suffix, token, fetchImpl)
  const metadata = async () => {
    try { return await read('') }
    catch (err) {
      if (!token || !credentialFailure(err)) throw err
      const fallback = await installationToken()
      if (fallback && fallback !== token) {
        token = fallback
        try { return await read('') } catch (fallbackError) { if (!credentialFailure(fallbackError)) throw fallbackError }
      }
      // Anonymous fallback is only for unavailable credentials, never rate
      // limits, network errors, or GitHub outages.
      token = null
      return read('')
    }
  }
  const checkAccess = async (freshIdentity = false) => {
    // Stored visibility can be stale (or internal with private=false). Require
    // current, explicit public visibility or the caller's effective permission.
    const data = await metadata() as { id?: unknown; full_name?: unknown; private?: unknown; visibility?: unknown; default_branch?: unknown }
    if (data?.id !== repo.repoId || typeof data.full_name !== 'string' || data.full_name.toLowerCase() !== repo.fullName.toLowerCase()) {
      throw new GithubApiError(404, 'no-repository')
    }
    if (data.private === false && data.visibility === 'public') return data
    if (!token) throw new GithubApiError(404, 'no-repository')
    const appToken = await installationToken()
    if (!appToken) throw new GithubApiError(404, 'no-repository')
    if (!(await githubRepoReadPermission(repo.fullName, appToken, await getIdentity(freshIdentity), fetchImpl))) {
      throw new GithubApiError(404, 'no-repository')
    }
    token = appToken
    return data
  }
  const current = await checkAccess()
  const defaultBranch = typeof current.default_branch === 'string' ? current.default_branch : ''
  return {
    recheckAccess: () => checkAccess(true),
    // Server-only credential, selected by the same live visibility/permission
    // gate as directory browsing. Never included in an HTTP response.
    readToken: () => token,
    async refs() {
      // Suggestions are bounded; the input also accepts any branch or tag name.
      const list = async (kind: string) => {
        const data = await read(`/${kind}?per_page=${REFS_PAGE}`)
        if (!Array.isArray(data)) throw new GithubApiError(502, 'github-malformed')
        return data
      }
      const [branches, tags] = await Promise.all([list('branches'), list('tags')])
      const names = (items: { name?: unknown }[]) => items.flatMap(item => typeof item?.name === 'string' ? [item.name] : [])
      // Each tag's commit, for the tag cache. A full page may leave tags
      // out; only a shorter one lists every tag.
      const tagCommits = tags.flatMap(item => typeof item?.name === 'string' && item.name && typeof item.commit?.sha === 'string'
        && /^[a-f\d]{40}$/u.test(item.commit.sha) ? [{ name: item.name, sha: item.commit.sha }] : [])
      return { defaultBranch, branches: names(branches), tags: names(tags), tagCommits, tagsComplete: tags.length < REFS_PAGE }
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
      const manifestPath = path ? `${path}/package.json` : 'package.json'
      const manifest = data.find(item => item?.path === manifestPath && item.name === 'package.json' && item.type === 'file' && !item.submodule_git_url
        && typeof item.size === 'number' && item.size >= 0 && item.size <= MAX_PACKAGE_BYTES && typeof item.sha === 'string' && /^[a-f\d]{40}$/iu.test(item.sha))
      const packageEntryPoints = manifest ? await readPackageEntryPoints(manifest.sha, path, read) : undefined
      const solidity = await readSolidityEntryPoints(path, data, read)
      return { entries, limited: data.length >= 1000, ...(packageEntryPoints ? { packageEntryPoints } : {}),
        ...(solidity.paths.length > 0 || solidity.limited ? { solidityEntryPoints: solidity.paths, soliditySuggestionsLimited: solidity.limited } : {}),
      }
    },
  }
}
