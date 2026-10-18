# Managed server

The managed server is the multi-user mode of `@preventive/triage`.
People sign in with GitHub, and an admin approves them and adds them to teams.
Each team is granted connected repositories, and its members see the content within those grants.
The server offers:

- **Reports**: uploaded scan reports, triaged and discussed together, with fix links and GitHub issues.
- **Bundles**: source bundles, uploaded or built on the server from a connected repository, with their files, advisories and comparisons.
- **Repositories**: connected GitHub repositories, read in a code viewer with their commits, issues, pull requests and agents.
- **npm viewer**: any published npm package version, with its files, risk, advisories and comparisons with other versions.
- **Dependency review**: teams review npm versions, and pull requests that change lockfiles show which new versions still need reviews.
- **Public links**: optional read-only links to a team's workspace.

For deployment on Vercel, see [the deployment guide](VERCEL.md).
For database selection, shared-storage boundaries and cleanup across both server modes, see [storage separation](../server-common/STORAGE.md).
For optional encryption of payloads on disk and in Vercel Blob, see [managed storage encryption](STORAGE-ENCRYPTION.md).

From a checkout, build the UI with `pnpm build` first, then start the server:

```sh
triage-server --mode managed   # or managed-e2e / e2e-managed, combined with the E2E server
```

`triage-server --help` lists the environment each mode reads.
In a combined mode, the first mode named is the client's default.
The main settings are:

| Variable | Purpose |
| --- | --- |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Required: the GitHub App's user-authorization credentials, used for sign-in |
| `OAUTH_CALLBACK_URL` | Required; it must be `https` on Vercel or with a non-loopback `HOST` |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG` | The same App's installation credentials, for private repositories and issues (see [Creating GitHub issues](../doc/reports.md#creating-github-issues) for its permissions) |
| `HOST`, `PORT` | Listen address, `127.0.0.1:8765` by default |
| `TRUST_PROXY` | `1` behind a reverse proxy, so the same-origin check reads `X-Forwarded-Host` and `X-Forwarded-Proto`; on by default for a loopback `HOST` and on Vercel |
| `MANAGED_DB_PATH` | SQLite database file, `server-managed/data/managed.db` by default |
| `MANAGED_DATABASE_URL` or `DATABASE_URL` | Neon database instead of SQLite; it also needs `BLOB_READ_WRITE_TOKEN` |
| `MANAGED_INITIAL_ADMIN_GITHUB_ID` | The first administrator (see [Account approval](#account-approval)) |
| `SESSION_TTL_MS`, `SESSION_COOKIE_NAME` | Session lifetime (14 days by default) and cookie name (`__Host-dvsid` by default) |
| `DEEPVIEW_ALLOW_SHARE` | `1` turns on [public workspace links](../doc/navigation.md#public-workspace-links) |
| `MAX_REPORT_BYTES`, `MAX_BUNDLE_BYTES` | Upload limits, 25 MiB for reports (up to 100 MiB) and 200 MiB for bundles by default |
| `MANAGED_STORAGE_ENCRYPTION_KEY` | Turns on [storage encryption](STORAGE-ENCRYPTION.md) |

# Roles and permissions

Each account has one workspace role, highest first:

| Role | Shown as | Can |
| --- | --- | --- |
| `admin` | Admin | Everything: users and roles, teams, repository connections, imports and deduplication, and all content |
| `manage` | Manager | Upload, publish, hide, assign and delete the reports and bundles they uploaded or reach through their teams, review unpublished reports there, build bundles and share their teams' public links |
| `triage` | Triage | Triage and comment on the findings they can see |
| `view` | Viewer | Read their teams' published reports, visible bundles and repositories, and use the npm viewer |
| `none` | No access | Nothing; new accounts start here |

A team is granted connected repositories, each whole (`/`) or from a directory down (`/foo` covers `/foo` and below, not `/foobar`).
Viewers and triagers see a team's published reports and visible bundles within those grants.
Reading a repository's live code also needs the reader's own GitHub read access, unless the repository is public.

Each team membership has two permissions, both off by default:

- **Dependencies**: findings in dependencies' own code.
  Findings about their effect on the app stay visible without it.
- **Security**: security findings and published bundle advisories.

Admins and managers are not limited by these two permissions.
In a team with dependency review enabled, its managers, its triagers with **Dependencies**, and admins review dependencies (see [dependency review](../doc/dependency-review.md)).
The full read rules for reports and blocked accounts are in [accounts](../doc/accounts.md).

# Account approval

GitHub sign-in establishes identity, and new accounts get the `none` (No access) role.
To preapprove the first administrator, set this optional variable to that account's numeric GitHub user ID:

```sh
MANAGED_INITIAL_ADMIN_GITHUB_ID=123456
```

On a GitHub sign-in, the matching account becomes `admin` only if its role is `none` and it is the **only user in the database**.
This applies at registration and at later logins, so an administrator who signed in before the variable was set signs in again.
The sole-user check and the promotion run in one transaction.
Configuration changes, restarts and existing sessions never promote anyone, and roles other than `none` are kept.
Any other user row, even one with No access, blocks promotion.
An unset or empty variable disables promotion, and an invalid ID fails startup.
Team membership, upload ownership and GitHub repository access never grant a workspace role.

With several users and no admin, a trusted operator approves the intended account directly in the managed SQLite or Neon database.
Verify the account's numeric GitHub user ID and put it in place of `123456`:

```sql
UPDATE managed_user SET role = 'admin' WHERE github_user_id = 123456;
```

Check that exactly the intended row was updated.
The administrator then approves other users in **Manage → Users** and assigns team access in **Manage → Teams**.
Database upgrades keep existing roles.
Combined managed + E2E deployments keep the E2E service's own authentication and permissions.

# Documentation

- [Accounts and access](../doc/accounts.md): who can read reports, No access accounts, viewing as another user, and linked GitHub accounts.
- [Navigation](../doc/navigation.md): page URLs, browser history, and public workspace links.
- [Reports](../doc/reports.md): uploading and importing reports, repository assignment, triage, comments, fix links, GitHub issues and activity history.
- [Bundles](../doc/bundles.md): uploading and building source bundles, their visibility, contents and advisories, and the admins' repository risk scan.
- [Code viewer](../doc/code-viewer.md): reading connected repositories' code, comparing revisions, and their commits, issues, pull requests, agents, pulse and replay.
- [Dependency review](../doc/dependency-review.md): reviewing npm versions, review rules for pull requests and default branches, and the host's `registerReviewedDependencies` hooks.
- [npm viewer](../doc/npm-viewer.md): opening a published npm package version, its files, risk, advisories and provenance.
