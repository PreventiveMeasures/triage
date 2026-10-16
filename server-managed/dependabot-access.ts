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
// Failures of verifying the sign-in that are GitHub's, not the sign-in's.
const PASSING: ReadonlySet<string> = new Set(['github-unreachable', 'github-rate-limited'])

// What of a repository's reader (repository-browser.ts) the alerts are asked
// with: its installation's token, the user's verified identity, and their
// permission level where its access gate asked GitHub of it already.
export interface AlertsReader {
  installationToken(): Promise<string | null>
  identity(): Promise<GithubIdentity>
  permission(): string | null
}

// `repo`'s Dependabot alerts (dependabot-alerts.ts), read with the App's
// installation token, the reader's, else the one GitHub tells the App of now,
// once the user's own permission on it lets them see them; else refused, the
// alerts not asked: `dependabot-not-installed`, `dependabot-unverified`, or
// `dependabot-forbidden`, naming their permission.
export async function appDependabotAlerts(config: ManagedConfig, repo: Pick<SelectedRepo, 'repoId' | 'fullName'>, reader: AlertsReader,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<DependabotAlert[]> {
  let token = await reader.installationToken()
  if (token == null) {
    const id = await repositoryInstallation(config, repo.repoId, repo.fullName, fetchImpl)
    token = id == null ? null : await repoAccessToken(config, id, fetchImpl)
  }
  if (token == null) throw new GithubApiError(403, 'dependabot-not-installed')
  let who
  try { who = await reader.identity() } catch (error) {
    if (error instanceof GithubApiError && PASSING.has(error.message)) throw error
    throw new GithubApiError(403, 'dependabot-unverified')
  }
  const permission = reader.permission() ?? await githubRepoPermission(repo.fullName, token, who, fetchImpl)
  if (!SEES_ALERTS.has(permission)) {
    throw new GithubApiError(403, 'dependabot-forbidden', null, `@${who.login}'s access to this repository (${permission}) doesn't let them see its Dependabot alerts on GitHub`)
  }
  return dependabotAlerts(repo.fullName, token, fetchImpl)
}
