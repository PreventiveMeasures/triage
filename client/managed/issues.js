import { managedFetch } from './request.js'

// These server errors guarantee no issue was created. Unknown 5xx responses
// (including database failures after the external write) remain uncertain.
const DEFINITE_ISSUE_FAILURES = new Set(['github-unavailable', 'unavailable', 'shutting-down', 'github-create-failed'])

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
    const error = typeof result?.error === 'string' && result.error ? result.error : null
    throw new Error(draft && response.status >= 500 && !DEFINITE_ISSUE_FAILURES.has(error) ? 'github-create-uncertain'
      : error ?? (draft ? 'github-create-uncertain' : 'github-unavailable'))
  }
  return result
}
