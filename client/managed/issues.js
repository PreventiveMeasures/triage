import { managedFetch } from './request.js'

// A creation is never retried: a lost response may still mean GitHub created it.
export async function requestGithubIssue(teamId, context, csrfToken, draft = null) {
  const path = `/api/teams/${encodeURIComponent(teamId)}/issues`
  let response, result
  try {
    response = await managedFetch(draft ? path : `${path}?${new URLSearchParams(context)}`, {
      method: draft ? 'POST' : 'GET', credentials: 'same-origin',
      headers: { accept: 'application/json', ...(draft ? { 'content-type': 'application/json', 'x-csrf-token': csrfToken } : {}) },
      ...(draft ? { body: JSON.stringify({ ...context, ...draft }) } : {}),
    })
    result = await response.json()
  } catch {
    throw new Error(draft ? 'github-create-uncertain' : 'github-unavailable')
  }
  if (!response.ok) {
    throw new Error(draft && response.status >= 500 ? 'github-create-uncertain'
      : result.error ?? (draft ? 'github-create-uncertain' : 'github-unavailable'))
  }
  return result
}
