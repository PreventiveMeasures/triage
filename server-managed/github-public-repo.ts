// What GitHub answers for a repository a package's manifest names, for the
// npm package viewer's Overview (npm-insights.ts): where GitHub says it is
// public, under the name it has now, where it was renamed or transferred
// since the manifest named it.
import { HttpError, createClient } from '@preventive/upstream/github.js'
import { plainObject } from './npm-packages.ts'

// GitHub has no repository to show: none by that name, or a redirect upstream
// won't follow, anywhere but to the repository by its id, or a second.
const NONE = new Set([301, 302, 307, 308, 404])

// What GitHub answers for `repo`, or where it was renamed or transferred, for
// the repository it is now (its `full_name`), where it says it is public,
// with the token it was asked with: `token`, or none where that is revoked.
// Upstream follows GitHub's redirect for such a repository to it by its id
// (`followRedirect`), once, with the same token. Null where GitHub has no such
// repository to show, or it is not public; anything else fails, to be asked
// again next time. Public is `visibility: 'public'`, as github-app.ts
// requires: an internal repository answers `private: false`.
export async function publicRepo(repo: string, token: string | null): Promise<{ json: Record<string, unknown> & { full_name: string }; auth: string | null } | null> {
  const ask = (auth: string | null) => createClient({ token: auth, userAgent: 'deepview-triage' }).getRepo({ repo, followRedirect: true }) as Promise<unknown>
  let auth = token, json: unknown
  try { json = await ask(token) }
  catch (error) {
    if (!(error instanceof HttpError) || !(error.status === 401 || NONE.has(error.status))) throw error
    if (error.status !== 401 || token === null) return null
    auth = null
    try { json = await ask(null) }
    catch (retry) { if (retry instanceof HttpError && NONE.has(retry.status)) return null; throw retry }
  }
  if (!plainObject(json) || json['private'] !== false || json['visibility'] !== 'public' || typeof json['full_name'] !== 'string') return null
  return { json: json as Record<string, unknown> & { full_name: string }, auth }
}
