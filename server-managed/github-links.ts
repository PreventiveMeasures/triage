// GitHub accounts a user links to their own on the profile page. A linked
// account's identity is reserved for that user: it can neither sign in nor
// register (upsertUser refuses it in the transaction that would create the
// user), and an account that has registered cannot be linked. The user's
// login and GitHub id stay the sign-in account's; the displayed name and
// avatar may come from any of their accounts.
import { randomUUID } from 'node:crypto'
import type { ManagedUser } from './db-methods.ts'
import { ManagedMutationError } from './management.ts'
import type { ManagedSql } from './sql.ts'

// login/name are snapshots of the account as it was last linked; linking it
// again refreshes them. Its avatar is cached under the link id (avatar-store.ts).
export const GITHUB_LINK_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_github_link (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES managed_user(id) ON DELETE CASCADE,
  github_user_id INTEGER NOT NULL UNIQUE,
  login          TEXT NOT NULL,
  name           TEXT,
  linked_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS managed_github_link_user_idx ON managed_github_link(user_id);
`

// managed_user columns added with the table. managed_user.name is the
// displayed name; github_name keeps the sign-in account's own. name_link and
// avatar_link name the linked account each comes from, NULL the sign-in one.
export const GITHUB_LINK_USER_COLUMNS: readonly (readonly [string, string])[] = [
  ['github_name', 'TEXT'],
  ['name_link', 'TEXT REFERENCES managed_github_link(id) ON DELETE SET NULL'],
  ['avatar_link', 'TEXT REFERENCES managed_github_link(id) ON DELETE SET NULL'],
]

export interface LinkedGithubAccount {
  id: string
  // Its GitHub account's numeric id, which GitHub never gives another.
  githubId: number
  login: string
  name: string | null
  linkedAt: number
}

export interface ManagedProfile {
  // Always the sign-in account's.
  login: string
  // The displayed name, and the sign-in account's own GitHub name.
  name: string | null
  githubName: string | null
  // The linked account the displayed name or avatar comes from, null the sign-in one.
  nameAccount: string | null
  avatarAccount: string | null
  accounts: LinkedGithubAccount[]
}

// A user as the app shows them where a GitHub login of theirs is named: by
// their id, whose avatar /api/avatar/<id> serves (the one they chose), their
// sign-in login and the name they chose.
export interface AppUser {
  id: string
  login: string
  name: string | null
}

// Which account the displayed name and avatar each come from: a linked
// account's id, or null for the sign-in account. An absent key is unchanged.
export interface ProfileChoice {
  name?: string | null
  avatar?: string | null
}

export interface GithubLinkStore {
  getProfile(userId: string): Promise<ManagedProfile | null>
  // Link `account` to the session's own user, or refresh the snapshot of one
  // they linked before. Refused for the sign-in account itself, an account
  // another user linked, and any account that has registered.
  linkGithubAccount(sessionId: string, account: ManagedUser, now: number): Promise<{ id: string; created: boolean }>
  // Unlink one of the session user's accounts, which may then sign in or
  // register again; a name or avatar it gave falls back to the sign-in
  // account's. Null when the user has no such link.
  unlinkGithubAccount(sessionId: string, id: string, now: number): Promise<LinkedGithubAccount | null>
  setProfileChoice(sessionId: string, choice: ProfileChoice, now: number): Promise<void>
  // The avatar to serve for `id`: a user's chosen linked account's, else `id`'s own.
  getAvatarKey(id: string): Promise<string>
  // The approved users signing in with, or having linked, each of
  // `accounts`, by the login as asked: by the account's numeric id where it
  // is known, which GitHub never gives another; else by its login (matched
  // regardless of case, as GitHub matches them), one more than one user
  // claims, renamed on GitHub since another signed in with it or linked it,
  // left out. No access users are left out.
  listUsersByAccount(accounts: readonly GithubAccount[]): Promise<Record<string, AppUser>>
}

// A GitHub account a repository's activity names: by its login, and its
// numeric id where GitHub told it.
export interface GithubAccount { login: string; githubId: number | null }

type LinkRow = { id: string; githubId: number; login: string; name: string | null; linkedAt: number }
const accountOf = (row: LinkRow): LinkedGithubAccount => ({ id: row.id, githubId: row.githubId, login: row.login, name: row.name, linkedAt: row.linkedAt })

// GithubLinkStore.listUsersByAccount.
async function usersByAccount(db: ManagedSql, accounts: readonly GithubAccount[]): Promise<Record<string, AppUser>> {
  if (accounts.length === 0) return {}
  const ids = accounts.flatMap(account => account.githubId ?? [])
  const logins = accounts.flatMap(account => account.githubId === null ? [account.login] : [])
  const rows = await db.prepare(`SELECT a.login, a.githubId, u.id, u.login AS appLogin, u.name, u.role FROM (
      SELECT login, github_user_id AS githubId, id AS claimant FROM managed_user
      UNION ALL SELECT login, github_user_id AS githubId, user_id AS claimant FROM managed_github_link
    ) a JOIN managed_user u ON u.id = a.claimant
    WHERE a.githubId IN (SELECT CAST(value AS BIGINT) FROM json_each(?)) OR lower(a.login) IN (SELECT lower(value) FROM json_each(?))`)
    .all(JSON.stringify(ids), JSON.stringify(logins)) as { login: string; githubId: number; id: string; appLogin: string; name: string | null; role: string }[]
  const byId = new Map(rows.map(row => [row.githubId, row]))
  const claims = new Map<string, typeof rows>()
  for (const row of rows) claims.set(row.login.toLowerCase(), [...claims.get(row.login.toLowerCase()) ?? [], row])
  const users: Record<string, AppUser> = {}
  for (const { login, githubId } of accounts) {
    const [user, ...others] = githubId === null ? claims.get(login.toLowerCase()) ?? [] : byId.has(githubId) ? [byId.get(githubId)!] : []
    if (!user || user.role === 'none' || others.some(other => other.id !== user.id)) continue
    users[login] = { id: user.id, login: user.appLogin, name: user.name }
  }
  return users
}

export function githubLinkMethods(db: ManagedSql): GithubLinkStore {
  // Linking is the session user's own act: never an admin's view as them,
  // nor an account that has not been approved for the workspace.
  async function sessionUser(sessionId: string, now: number): Promise<{ id: string; githubId: number }> {
    const row = await db.prepare(`SELECT u.id, u.github_user_id AS githubId, u.role FROM managed_session s JOIN managed_user u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ? AND s.viewer_session IS NULL`).get(sessionId, now) as { id: string; githubId: number; role: string } | undefined
    if (!row) throw new ManagedMutationError(401, 'unauthenticated')
    if (row.role === 'none') throw new ManagedMutationError(403, 'forbidden')
    return row
  }
  const linkOf = (userId: string, id: string) => db.prepare(`SELECT id, github_user_id AS githubId, login, name, linked_at AS linkedAt FROM managed_github_link
    WHERE id = ? AND user_id = ?`).get(id, userId) as Promise<LinkRow | undefined>

  return {
    async getProfile(userId) {
      const user = await db.prepare(`SELECT login, name, github_name AS githubName, name_link AS nameAccount, avatar_link AS avatarAccount
        FROM managed_user WHERE id = ?`).get(userId) as Omit<ManagedProfile, 'accounts'> | undefined
      if (!user) return null
      const accounts = await db.prepare(`SELECT id, github_user_id AS githubId, login, name, linked_at AS linkedAt FROM managed_github_link
        WHERE user_id = ? ORDER BY linked_at, id`).all(userId) as LinkRow[]
      return { ...user, accounts: accounts.map(accountOf) }
    },
    async linkGithubAccount(sessionId, account, now) {
      const user = await sessionUser(sessionId, now)
      if (account.githubUserId === user.githubId) throw new ManagedMutationError(409, 'github-account-own')
      if (await db.prepare('SELECT 1 AS found FROM managed_user WHERE github_user_id = ?').get(account.githubUserId)) {
        throw new ManagedMutationError(409, 'github-account-registered')
      }
      const existing = await db.prepare('SELECT id, user_id AS userId FROM managed_github_link WHERE github_user_id = ?')
        .get(account.githubUserId) as { id: string; userId: string } | undefined
      if (existing && existing.userId !== user.id) throw new ManagedMutationError(409, 'github-account-linked')
      if (existing) {
        await db.prepare('UPDATE managed_github_link SET login = ?, name = ? WHERE id = ?').run(account.login, account.name, existing.id)
        await db.prepare('UPDATE managed_user SET name = ?, updated_at = ? WHERE id = ? AND name_link = ?').run(account.name, now, user.id, existing.id)
        return { id: existing.id, created: false }
      }
      const id = randomUUID()
      await db.prepare(`INSERT INTO managed_github_link (id, user_id, github_user_id, login, name, linked_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, user.id, account.githubUserId, account.login, account.name, now)
      return { id, created: true }
    },
    async unlinkGithubAccount(sessionId, id, now) {
      const user = await sessionUser(sessionId, now)
      const link = await linkOf(user.id, id)
      if (!link) return null
      await db.prepare(`UPDATE managed_user SET
          name = CASE WHEN name_link = :link THEN github_name ELSE name END,
          name_link = CASE WHEN name_link = :link THEN NULL ELSE name_link END,
          avatar_link = CASE WHEN avatar_link = :link THEN NULL ELSE avatar_link END,
          updated_at = :now
        WHERE id = :user`).run({ link: id, now, user: user.id })
      await db.prepare('DELETE FROM managed_github_link WHERE id = ?').run(id)
      return accountOf(link)
    },
    async setProfileChoice(sessionId, choice, now) {
      const user = await sessionUser(sessionId, now)
      const links = new Map<string, LinkRow>()
      for (const id of [choice.name, choice.avatar]) {
        if (id == null || links.has(id)) continue
        const link = await linkOf(user.id, id)
        if (!link) throw new ManagedMutationError(404, 'no-account')
        links.set(id, link)
      }
      if (choice.name !== undefined) {
        // A linked account without a name leaves the user without one too.
        await db.prepare(`UPDATE managed_user SET name_link = :link,
            name = CASE WHEN :link IS NULL THEN github_name ELSE :name END, updated_at = :now
          WHERE id = :user`).run({ link: choice.name, name: choice.name === null ? null : links.get(choice.name)!.name, now, user: user.id })
      }
      if (choice.avatar !== undefined) {
        await db.prepare('UPDATE managed_user SET avatar_link = ?, updated_at = ? WHERE id = ?').run(choice.avatar, now, user.id)
      }
    },
    async getAvatarKey(id) {
      const row = await db.prepare('SELECT avatar_link AS link FROM managed_user WHERE id = ?').get(id) as { link: string | null } | undefined
      return row?.link ?? id
    },
    listUsersByAccount: accounts => usersByAccount(db, accounts),
  }
}
