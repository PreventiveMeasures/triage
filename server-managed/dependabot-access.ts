// A repository's Dependabot alerts for a repository risk scan, read with the
// App's installation token where the admin's own access lets them see them on
// GitHub, as the README's repository risk section tells.
import type { ManagedConfig } from './config.ts'
import type { SelectedRepo } from './db.ts'
import { type DependabotAlert, dependabotAlerts } from './dependabot-alerts.ts'
import { GithubApiError, type GithubIdentity, githubRepoPermission, repoAccessToken, repositoryInstallation } from './github-app.ts'

// The levels GitHub lets see a repository's Dependabot alerts by default
// (maintain's reads `write`).
const SEES_ALERTS: ReadonlySet<string> = new Set(['admin', 'write'])
// Failures of verifying the sign-in that are the sign-in's own: no token, or
// one of another account (repository-browser.ts getIdentity), or one GitHub no
// longer takes. Any other, as GitHub failing to answer, is told as it is.
const UNVERIFIED: ReadonlySet<string> = new Set(['no-repository', 'github-unauthorized'])

// What of a repository's reader (repository-browser.ts) the alerts are asked
// with: the user's verified identity, and their permission level where its
// access gate asked GitHub of it already.
export interface AlertsReader {
  identity(): Promise<GithubIdentity>
  permission(): string | null
}

// Alerts read, and their `recheck`: the user's access to them checked again,
// asked of GitHub afresh, just before they are told (repository-risk.ts), as
// access to the repository is, as it may be withdrawn meanwhile.
export interface AlertsRead { alerts: DependabotAlert[]; recheck(): Promise<void> }

// `repo`'s Dependabot alerts (dependabot-alerts.ts), read with the token of
// the App's installation GitHub tells covers it now, its token checked to read
// it (github-app.ts repositoryInstallation), never the one its connection
// keeps, which may no longer cover it, once the user's own permission on it
// lets them see them; else refused, the alerts not asked:
// `dependabot-not-installed`, `dependabot-unverified`, or
// `dependabot-forbidden`, naming their permission. The token is asked each
// time of repoAccessToken, which renews it before it expires, as the recheck
// may come long after the alerts are read.
export async function appDependabotAlerts(config: ManagedConfig, repo: Pick<SelectedRepo, 'repoId' | 'fullName'>, reader: AlertsReader,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<AlertsRead> {
  const id = await repositoryInstallation(config, repo.repoId, repo.fullName, fetchImpl)
  const tokenNow = async () => {
    const token = await repoAccessToken(config, id, fetchImpl)
    if (token == null) throw new GithubApiError(403, 'dependabot-not-installed')
    return token
  }
  const token = await tokenNow()
  let who
  try { who = await reader.identity() } catch (error) {
    throw error instanceof GithubApiError && UNVERIFIED.has(error.message) ? new GithubApiError(403, 'dependabot-unverified') : error
  }
  const seen = (permission: string) => {
    if (!SEES_ALERTS.has(permission)) {
      throw new GithubApiError(403, 'dependabot-forbidden', null, `@${who.login}'s access to this repository (${permission}) doesn't let them see its Dependabot alerts on GitHub`)
    }
  }
  seen(reader.permission() ?? await githubRepoPermission(repo.fullName, token, who, fetchImpl))
  const alerts = await dependabotAlerts(repo.fullName, token, fetchImpl)
  return { alerts, recheck: async () => { seen(await githubRepoPermission(repo.fullName, await tokenNow(), who, fetchImpl)) } }
}
