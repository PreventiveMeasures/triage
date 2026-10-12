// What GitHub answers for a repository a package's manifest names, for the
// npm package viewer's Overview (npm-insights.ts): where GitHub says it is
// public, under the name it has now, where it was renamed or transferred
// since the manifest named it.
import { HttpError, createClient } from '@preventive/upstream/github.js'
import { isGithubRepoName } from '../common/github-pr.ts'
import { plainObject, readLimited } from './npm-packages.ts'

const API_TIMEOUT_MS = 30_000
const API_BYTES = 1024 * 1024

// Where GitHub's API redirects a repository renamed or transferred: to the
// repository by its id.
const REPO_BY_ID = /^https:\/\/api\.github\.com\/repositories\/\d+$/u

// GitHub's answer at `url`, on its API, with `auth`, as upstream asks, but
// with a redirect answered rather than refused.
const askGithubApi = (url: string, auth: string | null) => fetch(url, {
  headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'deepview-triage', ...auth && { authorization: `Bearer ${auth}` } },
  redirect: 'manual', signal: AbortSignal.timeout(API_TIMEOUT_MS),
})

// What GitHub answers for `repo` with `auth`; null where it has none to show.
// A repository renamed or transferred answers a 301 to itself by its id,
// followed once, with the `auth` GitHub just took: upstream refuses the
// redirect, its error without the Location, so `repo` is asked again for it.
// A redirect anywhere else, or a second, is none to show; anything else fails.
async function askRepo(repo: string, auth: string | null): Promise<unknown> {
  try { return await createClient({ token: auth, userAgent: 'deepview-triage' }).getRepo({ repo }) }
  catch (error) {
    if (!(error instanceof HttpError) || ![301, 404].includes(error.status)) throw error
    if (error.status === 404) return null
  }
  const url = `https://api.github.com/repos/${repo.split('/').map(encodeURIComponent).join('/')}`
  const moved = await askGithubApi(url, auth)
  await moved.body?.cancel()
  if (moved.status === 404) return null
  if (moved.status !== 301) throw new Error(`GET ${url} ${moved.status}`)
  const location = moved.headers.get('location') ?? ''
  if (!REPO_BY_ID.test(location)) return null
  const res = await askGithubApi(location, auth)
  if (!res.ok) {
    await res.body?.cancel()
    if (res.status === 404 || (res.status >= 300 && res.status < 400)) return null
    throw new Error(`GET ${location} ${res.status}`)
  }
  // Its name, which upstream holds to the one asked, is held here to GitHub's
  // rules for a name.
  const json = JSON.parse((await readLimited(res, API_BYTES)).toString('utf8')) as unknown
  return plainObject(json) && typeof json['full_name'] === 'string' && isGithubRepoName(json['full_name']) ? json : null
}

// What GitHub answers for `repo`, or where it was renamed or transferred, for
// the repository it is now (its `full_name`), where it says it is public,
// with the token it was asked with: `token`, or none where that is revoked.
// Null where GitHub has no such repository to show, or it is not public;
// anything else fails, to be asked again next time. Public is `visibility:
// 'public'`, as github-app.ts requires: an internal repository answers
// `private: false`.
export async function publicRepo(repo: string, token: string | null): Promise<{ json: Record<string, unknown> & { full_name: string }; auth: string | null } | null> {
  let auth = token, json: unknown
  try { json = await askRepo(repo, token) }
  catch (error) {
    if (!(error instanceof HttpError) || error.status !== 401) throw error
    if (token === null) return null
    auth = null
    json = await askRepo(repo, null)
  }
  if (!plainObject(json) || json['private'] !== false || json['visibility'] !== 'public' || typeof json['full_name'] !== 'string') return null
  return { json: json as Record<string, unknown> & { full_name: string }, auth }
}
