import { managedFetch } from '../../client/managed/request.js'
import { managedAppState } from './state.js'

const ERRORS = {
  'review-content-changed': 'The package bytes changed. Reload the package before reviewing.',
  'review-conflict': 'This review changed or was published in another tab. Reload the page before editing it again.',
  'package-not-found': 'One of these package versions is no longer available to you.',
  'unknown-review-file': 'This file is not in the comparison.',
  'non-text-review-file': 'Verdicts for non-text files are not supported yet.',
  'bad-review-teams': 'Select at least one team you belong to with dependency review enabled. Refresh if team access changed.',
  'no-reviewed-files': 'Review at least one changed file before publishing.',
  'package-json-not-reviewed': 'Review package.json before publishing a partial review.',
  'bad-final-verdict': 'Choose a final verdict no more favorable than the file verdicts.',
  'review-malware': 'Malware detected. Only Reject is available.',
  'review-critical-vulnerability': 'Critical vulnerabilities detected. Choose Request changes or Reject.',
  forbidden: 'Reviewing requires triage access.',
}

async function requestReview(path, signal, operation, change, csrfToken) {
  const generation = managedAppState.generation
  const response = await managedFetch(`/api/npm/reviews${path}`, {
    credentials: 'same-origin', signal: AbortSignal.any([signal, managedAppState.sessionController.signal]),
    ...(change ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(change) } : {}),
  })
  const body = await response.json()
  if (generation !== managedAppState.generation || signal.aborted) throw new DOMException('Session changed', 'AbortError')
  if (!response.ok) throw new Error(ERRORS[body.error] ?? `Could not ${operation} (${response.status}).`)
  return body
}
export function myDependencyReviews(cursor, signal) {
  const query = cursor ? `?${new URLSearchParams({ beforeTime: cursor.time, beforeId: cursor.id })}` : ''
  return requestReview(`/mine${query}`, signal, 'load your reviews')
}
export function discardDependencyReview(reviewId, revision, csrfToken, signal) {
  return requestReview('/discard', signal, 'discard review', { reviewId, revision }, csrfToken)
}
export async function latestDependencyReview(target, signal) {
  const query = new URLSearchParams({ package: target.package, version: target.version, integrity: target.integrity })
  return (await requestReview(`/latest?${query}`, signal, 'load your latest review')).review
}
export function dependencyReviews(context, change, csrfToken, signal) {
  const params = new URLSearchParams(Object.entries(context).filter(([, value]) => value !== null))
  return requestReview(change ? '' : `?${params}`, signal, `${change ? 'save' : 'load'} reviews`, change && { ...context, ...change }, csrfToken)
}
