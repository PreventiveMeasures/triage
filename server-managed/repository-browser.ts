import type { ManagedConfig } from './config.ts'
import type { SelectedRepo } from './db.ts'
import { GithubApiError, githubJson, githubRepoReadPermission, githubUserIdentity, repoAccessToken } from './github-app.ts'

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
    async reader(repo: SelectedRepo) {
      let token = Promise.resolve<string | null>(null)
      if (repo.installationId != null) {
        const cached = tokens.get(repo.installationId)
        token = cached ?? repoAccessToken(config, repo.installationId, fetchImpl).catch((err: unknown) => {
          if (!(err instanceof GithubApiError)) throw err
          // Stale installations cannot prevent verified anonymous public access.
          return null
        })
        if (!cached) tokens.set(repo.installationId, token)
      }
      return repositoryReader(repo, await token, getIdentity, fetchImpl)
    },
  }
}

async function repositoryReader(repo: SelectedRepo, token: string | null, getIdentity: (fresh?: boolean) => Promise<GithubIdentity>, fetchImpl: typeof fetch) {
  const base = `https://api.github.com/repos/${repo.fullName.split('/').map(encodeURIComponent).join('/')}`
  const read = (suffix: string) => githubJson(base + suffix, token, fetchImpl)
  const metadata = async () => {
    try { return await read('') }
    catch (err) {
      if (!token || !(err instanceof GithubApiError)) throw err
      // A valid installation token may have lost this particular repository.
      // After falling back, all reads and rechecks stay anonymous.
      token = null
      return read('')
    }
  }
  const checkAccess = async (freshIdentity = false) => {
    // Stored visibility can be stale (or internal with private=false). Require
    // current, explicit public visibility or the caller's effective permission.
    const data = await metadata() as { id?: unknown; full_name?: unknown; private?: unknown; visibility?: unknown }
    if (data?.id !== repo.repoId || typeof data.full_name !== 'string' || data.full_name.toLowerCase() !== repo.fullName.toLowerCase()) {
      throw new GithubApiError(404, 'no-repository')
    }
    if (data.private === false && data.visibility === 'public') return
    if (!token) throw new GithubApiError(404, 'no-repository')
    if (!(await githubRepoReadPermission(repo.fullName, token, await getIdentity(freshIdentity), fetchImpl))) {
      throw new GithubApiError(404, 'no-repository')
    }
  }
  await checkAccess()
  return {
    recheckAccess: () => checkAccess(true),
    async refs() {
      // Suggestions are bounded; the input also accepts any branch or tag name.
      const results = await Promise.all(['branches', 'tags'].map(async kind => {
        const data = await read(`/${kind}?per_page=100`)
        if (!Array.isArray(data)) throw new GithubApiError(502, 'github-malformed')
        return data.flatMap(item => typeof item?.name === 'string' ? [item.name] : [])
      }))
      return { defaultBranch: repo.defaultBranch, branches: results[0], tags: results[1] }
    },
    async commit(ref: string) {
      if (/^[a-f\d]{40}$/iu.test(ref)) return ref
      const data = await read(`/commits/${encodeURIComponent(ref || repo.defaultBranch || 'HEAD')}`) as { sha?: unknown }
      if (typeof data?.sha !== 'string' || !/^[a-f\d]{40}$/iu.test(data.sha)) throw new GithubApiError(502, 'github-malformed')
      return data.sha
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
      return { entries, limited: data.length >= 1000 }
    },
  }
}
