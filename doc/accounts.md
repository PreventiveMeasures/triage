# Accounts and access

Users sign in with GitHub, and each account has one workspace role that decides what it can read and change.
This page covers who can read reports, what a No access account is refused, how an admin views the app as another user, and how users link more GitHub accounts to their own.
New accounts and the first administrator are approved as described in [Account approval](../server-managed/README.md#account-approval).

## Report access

Report lists, previews, downloads and triage reads all use one access scope:

- Admins can read all reports.
- Managers can read their own uploads, and reports within their teams' repository paths.
- Other readers need a published report inside one of their teams' paths.

For the Viewer, Triage and No access roles, being the uploader grants no access.
Changing a report's repository, publishing it or deleting it also requires access to its current repository path.
Assigning a report to a new location requires access to the destination path.

## No access accounts

The `none` (No access) role is refused at the managed data API, even when the account owns uploads or belongs to teams.
That covers team names and avatars, report and triage data, bundle caches, GitHub pull request lookups, upload parts and every management endpoint.

Unauthenticated requests get `401`.
Unapproved accounts get `403` before any request body or resource is read.
Public bootstrap, the user's own session status and sign-out stay available.
When a user's role changes to No access, the app shows a no-access page and clears the data it had loaded.

## Viewing as another user

To check what an account can reach, an admin selects **View as** on its row in **Manage → Users**.
The app reloads as that user, with their role, teams, Dependencies and Security permissions unchanged.
A sidebar banner names the user until the admin selects **Stop**, or **Return to @admin** in the account menu.

A view is read-only:

- Every write is refused with `403 { "error": "view-only" }` before the request body is read, including triage, comments, issues, public links, uploads and all management changes.
- Controls stay as the viewed user has them, so the admin sees what that user is offered, and the app shows each refusal.
- Reads behave as for the viewed user.
- Requests never use the viewed user's GitHub authorization, so private pull request and issue status, repository browsing, discovery and issue creation are left out.
- A combined deployment's E2E requests are unaffected.

Security rules:

- Only an admin can open a view, through a same-origin, CSRF-checked request, and never of their own account.
- The view is a separate session in its own `dvview` cookie (`__Host-dvview` when Secure), valid only together with the admin session that opened it.
- A view token is never accepted as a session cookie, and a request with an ended view never falls back to the admin's writable session.
- The view ends when the admin stops it, logs out, loses their session or loses the admin role; it does not come back if the role is granted again.
- Opening a view adds `viewed as <login>` to the admin's access history, and does not update the viewed user's Last seen or Last activity.

`SESSION_COOKIE_NAME` cannot be `dvview` or an OAuth state cookie name (`dvstate`, `dvissuestate`, `dvlinkstate`), and startup fails if it is.

## Profile and linked GitHub accounts

**Profile** in the account menu (`/my/profile`) shows the user's avatar, name and the GitHub accounts linked to theirs.
**Link GitHub account** runs GitHub's authorization again with its account picker, and links the account that completes it.
Linking needs any role but No access, and is refused while an admin views as the user.
The link request is bound to the session that started it and expires after ten minutes.
The linked account's token is used only to read its identity and avatar, and is never stored.

A linked account is reserved for its user: it cannot sign in (`403 github-account-linked`) or register.
Linking is refused for the sign-in account itself, an account another user linked, and any account that has signed in here before.
Unlinking frees the account to sign in or register again.
Linking and unlinking are recorded in the access history.

A user's login and GitHub ID always stay the sign-in account's.
The user picks their displayed name and avatar from any of their accounts, and the choice shows wherever they appear.
A linked account's name is kept as it was when linked, and linking it again refreshes it.
Unlinking the account that gave the name or avatar switches it back to the sign-in account's.

## Accounts in repository activity

In the [code viewer](./code-viewer.md)'s commits, issues, pull requests, agents and pulse, a GitHub account shows as an approved user when that user signs in with it or has linked it.
Pulse counts all of a user's accounts as one contributor.
Each answer names only the accounts in it, and readers are never sent a list of users.

An account is matched by its numeric GitHub ID where GitHub gives one, else by its login, ignoring case.
So a renamed account still shows as its user, and its old login, if another account takes it, does not.
A login that two users claim shows as the login alone.
A commit with no GitHub user, such as a GitHub App bot's, is matched by the account its noreply address names.
GitHub's older noreply address, `<login>@users.noreply.github.com`, names no ID, so the account of its login is looked up by that login, once per read (with a token).

The known agents (Claude, Codex, Copilot, Dependabot, GitHub Actions, Neo and Cursor) show as agents, matched by their GitHub accounts, or by author name for commits GitHub names no account for.
Pulse counts each agent as one contributor.
