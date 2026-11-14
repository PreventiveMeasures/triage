// Values as GitHub's REST and GraphQL APIs answer them, as the repository
// readers keep them (repository-history.ts, commit-coauthors.ts, pull-reviews.ts
// and the Issues, Agents and Pulse tabs' readers): any other value none.

export const MAX_NAME = 256
// A login of GitHub's: a user's, an organization's or a GitHub App's bot's.
export const LOGIN = /^[A-Za-z\d][A-Za-z\d-]{0,38}(?:\[bot\])?$/u
// A commit's or a blob's id, as GitHub names one.
export const SHA = /^[a-f\d]{40}$/u

// A time GitHub names as an ISO 8601 date, in milliseconds since the epoch.
export const timeOf = (value: unknown) => {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isSafeInteger(at) ? at : null
}

// An id or a number GitHub gives (an account's, a repository's, an issue's):
// a positive integer.
export const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0

// A count GitHub gives, 0 where it gives none.
export const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0

// A name or text GitHub gives, trimmed, as much of it as `max` characters;
// null where it is empty.
export const nameOf = (value: unknown, max = MAX_NAME) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
