// A repository's Dependabot alerts as a repository risk scan asks them
// (repository-risk.ts), for an admin GitHub lets see them: their own access
// to the repository checked through the App's installation on it, admin or
// write (maintain's among it), as GitHub lets those see its Dependabot alerts
// by default, and the alerts then read with the installation's token, as the
// admin's own sign-in may be an identity-only App's (an OAuth App's, or one
// with no permissions), which reads public data alone. Stricter than GitHub
// where a custom role or the security manager role grants them on read
// access: those are refused.
import type { ManagedConfig } from './config.ts'
import type { SelectedRepo } from './db.ts'
import { type DependabotAlert, dependabotAlerts } from './dependabot-alerts.ts'
import { GithubApiError, githubJson, repoAccessToken, repositoryInstallation } from './github-app.ts'

const API = 'https://api.github.com'
// The access GitHub lets see a repository's Dependabot alerts, as its
// collaborator permission tells it (maintain's reads `write`).
const SEES_ALERTS: ReadonlySet<string> = new Set(['admin', 'write'])
// Failures of verifying the sign-in that are GitHub's, not the sign-in's.
const PASSING: ReadonlySet<string> = new Set(['github-unreachable', 'github-rate-limited'])

export interface GithubIdentity { id: number; login: string }
type Repo = Pick<SelectedRepo, 'repoId' | 'fullName' | 'installationId'>

// The App's installation on `repo` and its token: the one the connection
// keeps, else, or where that one is gone, the one GitHub tells the App of now
// (github-app.ts repositoryInstallation); null where there is none.
async function installationOf(config: ManagedConfig, repo: Repo, fetchImpl: typeof fetch) {
  if (repo.installationId != null) {
    try {
      const token = await repoAccessToken(config, repo.installationId, fetchImpl)
      if (token != null) return { id: repo.installationId, token }
    } catch (error) {
      if (!(error instanceof GithubApiError && [401, 404].includes(error.status))) throw error
    }
  }
  const id = await repositoryInstallation(config, repo.repoId, repo.fullName, fetchImpl)
  const token = id == null ? null : await repoAccessToken(config, id, fetchImpl)
  return id == null || token == null ? null : { id, token }
}

// `who`'s permission on `fullName`, as the installation's `token` asks GitHub
// (Metadata: read), its teams', organization's and enterprise's grants among
// it; `none` where GitHub knows of none, or answers of another account.
async function permissionOf(token: string, fullName: string, who: GithubIdentity, fetchImpl: typeof fetch): Promise<string> {
  const path = fullName.split('/').map(encodeURIComponent).join('/')
  let body
  try { body = await githubJson(`${API}/repos/${path}/collaborators/${encodeURIComponent(who.login)}/permission`, token, fetchImpl) as { permission?: unknown; user?: { id?: unknown } } | null } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) return 'none'
    throw error
  }
  return body?.user?.id === who.id && typeof body.permission === 'string' && /^\w{1,20}$/u.test(body.permission) ? body.permission : 'none'
}

// `repo`'s Dependabot alerts (dependabot-alerts.ts), read with the App's
// installation token once `identity`, the admin's own GitHub account as their
// sign-in verifies it (repository-browser.ts), is found to have access GitHub
// lets see them: refused, by a code and why, where the App isn't installed on
// it (`dependabot-not-installed`), the sign-in can't be verified
// (`dependabot-unverified`) or the account's access doesn't let them see the
// alerts (`dependabot-forbidden`); nothing is asked of the alerts then.
export async function appDependabotAlerts(config: ManagedConfig, repo: Repo, identity: () => Promise<GithubIdentity>,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<DependabotAlert[]> {
  const installation = await installationOf(config, repo, fetchImpl)
  if (!installation) {
    throw new GithubApiError(403, 'dependabot-not-installed', null, 'the GitHub App has no installation on this repository that reads it: install it there to read its Dependabot alerts')
  }
  let who
  try { who = await identity() } catch (error) {
    if (error instanceof GithubApiError && PASSING.has(error.message)) throw error
    throw new GithubApiError(403, 'dependabot-unverified', null, 'your GitHub sign-in couldn\'t be verified, to check your access to this repository: sign in again')
  }
  const permission = await permissionOf(installation.token, repo.fullName, who, fetchImpl)
  if (!SEES_ALERTS.has(permission)) {
    throw new GithubApiError(403, 'dependabot-forbidden', null,
      `@${who.login}'s access to this repository (${permission}) doesn't let them see its Dependabot alerts on GitHub, which takes write, maintain or admin`)
  }
  return dependabotAlerts(repo.fullName, installation.token, fetchImpl)
}
