import { managedFetch } from '../../client/managed/request.js'
import { managedAppState } from './state.js'

const ERRORS = {
  'review-content-changed': 'The package bytes changed. Reload the package before reviewing.',
  'review-conflict': 'This review changed or was published in another tab. Refresh reviews before editing it again.',
  'package-not-found': 'One of these package versions is no longer available to you.',
  'unknown-review-file': 'This file is not in either package version.',
  'bad-review-teams': 'Select at least one team you belong to with dependency review enabled. Refresh if team access changed.',
  'no-reviewed-files': 'Review at least one changed file before publishing.',
  'package-json-not-reviewed': 'Review package.json before publishing a partial review.',
  'bad-final-verdict': 'Choose a final verdict no more favorable than the file verdicts.',
  'review-malware': 'Malware detected. Only Reject is available.',
  'review-critical-vulnerability': 'Critical vulnerabilities detected. Choose Request changes or Reject.',
  forbidden: 'Reviewing requires triage access.',
}

export async function myDependencyReviews(cursor, signal) {
  const generation = managedAppState.generation
  const query = cursor ? `?${new URLSearchParams({ beforeTime: cursor.time, beforeId: cursor.id })}` : ''
  const response = await managedFetch(`/api/npm/reviews/mine${query}`, { credentials: 'same-origin',
    signal: AbortSignal.any([signal, managedAppState.sessionController.signal]) })
  const body = await response.json()
  if (generation !== managedAppState.generation || signal.aborted) throw new DOMException('Session changed', 'AbortError')
  if (!response.ok) throw new Error(`Could not load your reviews (${response.status}).`)
  return body
}
export async function discardDependencyReview(reviewId, revision, csrfToken, signal) {
  const generation = managedAppState.generation
  const response = await managedFetch('/api/npm/reviews/discard', {
    method: 'POST', credentials: 'same-origin',
    signal: AbortSignal.any([signal, managedAppState.sessionController.signal]),
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ reviewId, revision }),
  })
  const body = await response.json()
  if (generation !== managedAppState.generation || signal.aborted) throw new DOMException('Session changed', 'AbortError')
  if (!response.ok) throw new Error(ERRORS[body.error] ?? `Could not discard review (${response.status}).`)
}
export async function latestDependencyReview(target, signal) {
  const generation = managedAppState.generation
  const query = new URLSearchParams({ package: target.package, version: target.version, integrity: target.integrity })
  const response = await managedFetch(`/api/npm/reviews/latest?${query}`, { credentials: 'same-origin',
    signal: AbortSignal.any([signal, managedAppState.sessionController.signal]) })
  const body = await response.json()
  if (generation !== managedAppState.generation || signal.aborted) throw new DOMException('Session changed', 'AbortError')
  if (!response.ok) throw new Error(`Could not load your latest review (${response.status}).`)
  return body.review
}
export async function dependencyReviews(context, change, csrfToken, signal) {
  const generation = managedAppState.generation
  const params = new URLSearchParams(Object.entries(context).filter(([, value]) => value !== null))
  const response = await managedFetch(`/api/npm/reviews${change ? '' : `?${params}`}`, {
    method: change ? 'POST' : 'GET', credentials: 'same-origin',
    signal: AbortSignal.any([signal, managedAppState.sessionController.signal]),
    ...(change ? { headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ ...context, ...change }) } : {}),
  })
  const body = await response.json()
  if (generation !== managedAppState.generation || signal.aborted) throw new DOMException('Session changed', 'AbortError')
  if (!response.ok) throw new Error(ERRORS[body.error] ?? `Could not ${change ? 'save' : 'load'} reviews (${response.status}).`)
  return body
}
