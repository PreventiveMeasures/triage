import type { StoredUser } from './db.ts'

const WHITEHAT = [
  291301, // ChALkeR
]
const whitehatIds = new Set(WHITEHAT)

// (1) Server permission to add repositories. Keep this independent of GitHub
// identity and ecosystem exceptions if other install modes broaden it later.
export function canAddRepositories(user: StoredUser): boolean {
  return user.role === 'admin'
}

// (3b) Only the ecosystem safeguard for public repositories is bypassed by
// WHITEHAT. Callers must separately establish (0) server readability, (1) add
// permission, and (2) server admin or GitHub access to this repository.
export function passesPublicRepositorySafeguard(githubUserId: number | null, involved: boolean): boolean {
  return involved || (githubUserId != null && whitehatIds.has(githubUserId))
}

// Arbitrary public repositories have no involvement evidence, so (2) requires
// admin even if (1) expands in the future. This capability is also the UI gate.
export function canAddAnyPublicRepository(user: StoredUser, githubUserId: number | null): boolean {
  return canAddRepositories(user) && user.role === 'admin' && passesPublicRepositorySafeguard(githubUserId, false)
}
