import { managedFetch } from './request.js'

// The signed-in user's profile (server-managed/github-links.ts): their login,
// the name shown for them, the GitHub accounts linked to theirs, and which of
// those the displayed name and avatar come from (a linked account's id, or
// null for the sign-in account). Each call answers the profile as it now is.
export function fetchProfile({ signal } = {}) {
  return profileRequest('/api/auth/profile', { signal }, 'load your profile')
}

// `choice` is { name?, avatar? }, each a linked account's id or null.
export function chooseProfileAccounts(choice, csrfToken, { signal } = {}) {
  return profileRequest('/api/auth/profile', { method: 'POST', body: JSON.stringify(choice), csrfToken, signal }, 'save your profile')
}

export function unlinkGithubAccount(id, csrfToken, { signal } = {}) {
  return profileRequest(`/api/auth/profile/accounts/${encodeURIComponent(id)}`, { method: 'DELETE', csrfToken, signal }, 'unlink the account')
}

async function profileRequest(url, { method = 'GET', body, csrfToken, signal }, operation) {
  const res = await managedFetch(url, {
    method, credentials: 'same-origin', signal, ...(body ? { body } : {}),
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
  })
  const data = await res.json().catch(() => null)
  const profile = res.ok ? profileFrom(data?.profile) : null
  if (!profile) throw new Error(`Could not ${operation} (${res.ok ? 'unreadable answer' : data?.error ?? res.status}).`)
  return profile
}

function profileFrom(body) {
  const text = value => typeof value === 'string' ? value : null
  if (typeof body?.login !== 'string' || !Array.isArray(body.accounts)) return null
  return {
    login: body.login, name: text(body.name), githubName: text(body.githubName),
    nameAccount: text(body.nameAccount), avatarAccount: text(body.avatarAccount),
    accounts: body.accounts.filter(account => typeof account?.id === 'string' && typeof account.login === 'string')
      .map(account => ({ id: account.id, login: account.login, name: text(account.name),
        linkedAt: Number.isSafeInteger(account.linkedAt) ? account.linkedAt : null })),
  }
}
