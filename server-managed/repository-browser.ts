import type { ManagedConfig } from './config.ts'
import type { SelectedRepo } from './db.ts'
import { GithubApiError, githubJson, repoAccessToken } from './github-app.ts'

export interface RepositoryEntry { name: string; path: string; type: 'dir' | 'file' | 'symlink' | 'submodule' }

// Restricted managers can walk the ancestors of their grants, without seeing
// sibling names or files outside those grants. null means the entire repo.
export function scopedDirectory(path: string, scopes: (string | null)[]): RepositoryEntry[] | null {
  if (scopes.some(scope => !scope || path === scope || path.startsWith(scope + '/'))) return null
  const prefix = path ? path + '/' : ''
  const names = new Set(scopes.filter((scope): scope is string => !!scope && scope.startsWith(prefix)).map(scope => scope.slice(prefix.length).split('/')[0]!))
  return [...names].toSorted().map(name => ({ name, path: prefix + name, type: 'dir' }))
}

export async function repositoryReader(config: ManagedConfig, repo: SelectedRepo, fetchImpl: typeof fetch = globalThis.fetch) {
  const token = await repoAccessToken(config, repo.installationId, fetchImpl)
  if (repo.private && !token) throw new GithubApiError(503, 'repository-access-unavailable')
  const base = `https://api.github.com/repos/${repo.fullName.split('/').map(encodeURIComponent).join('/')}`
  const read = (suffix: string) => githubJson(base + suffix, token, fetchImpl)
  return {
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
