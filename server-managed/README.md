# Managed browser navigation

Build the UI with `pnpm build` before starting a managed or combined server.
Managed pages use the History API: navigation pushes a URL, Back/Forward
restores it, and reloading opens the same page. PWA launches into an existing
window also navigate to their managed page URL.

| URL | Page |
| --- | --- |
| `/` | Team landing / login |
| `/teams/:teamId` | Team findings |
| `/teams/:teamId/files` | Team files |
| `/teams/:teamId/reports/:reportId` | Report findings |
| `/teams/:teamId/reports/:reportId/files` | Report files |
| `/manage` | Manage overview |
| `/manage/bundles` | Bundles |
| `/manage/scans` | Scans |
| `/manage/reports` | Reports |
| `/manage/repositories` | Repositories (admin) |
| `/manage/users` | Users (admin) |
| `/manage/teams` | Teams (admin) |
| `/manage/history` | Activity history; optional `?actor=<login>` |

Manage pages require a manager or admin. Team and report URLs require the
current user's team access. Unavailable pages return to the landing page;
Files falls back to Findings when the reports have no multi-file source tree.
Switching between Findings and Files reuses the loaded reports and filters.

Managed and combined servers serve the same entry HTML for page GET/HEAD
requests, including direct loads of nested URLs. Assets resolve from `/`.
`/api` and `/api/*` always retain their API handling, including unknown routes;
missing assets and non-GET/HEAD requests do not receive fallback HTML.

E2E and local mode do not use this page router. A mode switch returns to `/`
and invalidates the old managed history entries, so Back cannot reopen them.
History contains a navigation generation only, with no report or triage data.
The server mode's advertised default still applies on reload.

# Activity history

`/manage/history` reads `GET /api/admin/history?page=1&limit=100&kind=all&q=`.
The server returns `{ history, total, page, limit }`, newest first, with at most
100 entries per page. Type and text filters apply before pagination. Supported
types are `triage`, `upload`, `visibility`, `access`, `repository`, and `delete`.

Admins see workspace activity. Managers see only triage for findings in their
currently accessible, published team reports, with repository paths enforced.
Counts, search results, and report names obey the same access restrictions.
The client retains history only in memory; responses are never HTTP-cached.

Uploads and triage changes already stored in the database appear automatically.
New uploads are recorded atomically with their metadata. Report publication,
repository assignments and connections, content deletion, roles, teams, and
team access changes are recorded after successful management requests.
Repeated edits that change nothing, failed requests, and deduplicated uploads
do not add entries. Upload and management snapshots survive content deletion.
Triage history follows `TRIAGE_HISTORY_LIMIT` and explicit triage deletion.

Older management actions were not recorded and cannot be reconstructed; older
triage events may have no originating report name. The feed contains actors,
actions, targets, and timestamps, not annotation bodies or credentials.
