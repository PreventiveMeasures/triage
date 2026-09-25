import { createHash } from 'node:crypto'
import type { ManagedConfig } from './config.ts'
import { GithubApiError, filterInstalledRepos, listInstalledRepos, listUserRepos } from './github-app.ts'
import type { ConnectedRepo, RepoListing } from './github-app.ts'

const CACHE_MS = 60_000
const MAX_ENTRIES = 100
interface Entry {
  expires: number
  pending: boolean
  value: Promise<ConnectedRepo[]>
}

// One directory per HTTP handler. Searches/pages reuse discovery, but selected
// flags still come from the database on every request. User results are scoped
// to both the managed identity and its current GitHub credential. This cache is
// only for discovery; connecting a repo still verifies fresh installation access.
export class RepositoryDiscovery {
  private readonly cache = new Map<string, Entry>()
  private readonly config: ManagedConfig
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(config: ManagedConfig, fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args), now: () => number = Date.now) {
    this.config = config
    this.fetchImpl = fetchImpl
    this.now = now
  }

  private read(key: string, load: () => Promise<ConnectedRepo[]>): Promise<ConnectedRepo[]> {
    const cached = this.cache.get(key)
    if (cached && (cached.pending || cached.expires > this.now())) return cached.value
    this.cache.delete(key)
    while (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!)
    const entry: Entry = { expires: 0, pending: true, value: Promise.resolve([]) }
    entry.value = load().then(repos => {
      entry.expires = this.now() + CACHE_MS
      entry.pending = false
      return repos
    }, (err: unknown) => {
      if (this.cache.get(key) === entry) this.cache.delete(key)
      throw err
    })
    this.cache.set(key, entry)
    return entry.value
  }

  async list(scope: 'installed' | 'public', userId: string, token: string | null, showAll = false, refresh = false): Promise<RepoListing> {
    // Invalidate derived user results along with the installation catalogue.
    // An older in-flight read cannot repopulate this map after refresh.
    if (refresh) this.cache.clear()
    const installed = () => this.read('installed', () => listInstalledRepos(this.config, this.fetchImpl))
    if (scope === 'installed' && showAll) return { repositories: await installed(), tokenMissing: false }
    const publicInstalled = async (): Promise<ConnectedRepo[]> => (await installed()).filter(repo => !repo.private)
    if (token == null) return { repositories: scope === 'installed' ? await publicInstalled() : [], tokenMissing: true }
    const credential = createHash('sha256').update(token).digest('hex')
    const key = JSON.stringify([scope, userId, credential])
    try {
      const repositories = await this.read(key, async () => {
        if (scope === 'installed') return filterInstalledRepos(this.config, await installed(), token, this.fetchImpl)
        const [userRepos, installedRepos] = await Promise.all([
          listUserRepos(token, this.fetchImpl), installed(),
        ])
        const installedIds = new Set(installedRepos.map(repo => repo.id))
        return userRepos.filter(repo => !repo.private && !installedIds.has(repo.id))
      })
      return { repositories, tokenMissing: false }
    } catch (err) {
      if (!(err instanceof GithubApiError) || err.status !== 401) throw err
      return { repositories: scope === 'installed' ? await publicInstalled() : [], tokenMissing: true }
    }
  }
}
