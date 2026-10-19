# Repository code viewer

The code viewer lets team members read a connected repository live from GitHub, in the same bundle view an npm version uses.
It has the **Treemap**, **Code**, **Search**, **Compare** and **Activity** tabs, and Activity holds the **Commits**, **Issues**, **Pull requests**, **Agents**, **Pulse** and **Replay** views.
Every tab reads GitHub live, with the reader's own GitHub access, within their teams' grants.

## Opening a repository

A repository opens from the `</>` on its row on the Repositories page, or from its row on a team's Repositories tab.
Its route is `/repo/<repo id>`; see [page routes](./navigation.md) for the full set.
It opens the default branch's head, and the route then names that commit, so a link or a reload shows the same files after the branch moves.

The header picks the repository (among those the reader may browse), the revision (a branch, a tag or a commit) and the directory.
It also links the commit's tree on GitHub, and each file links to itself on GitHub at that commit.
Switching revision keeps the directory and the tab.
Issues, Pull requests, Agents and Pulse cover the whole repository, so they show no revision or directory.

## Who can see what

| Reader | Can read |
| --- | --- |
| Team member with the view role or above | A repository their team has a grant for, within the grant's paths, and only where their own GitHub account can read it or it is public |
| Admin | Every connected repository, but only where their GitHub account can read it or it is public |
| Anyone else | Nothing |

Every read passes both gates, on its own, each time:

- Managed access: an admin, or a team member whose team's grant covers the path.
- GitHub access: the reader has GitHub read permission on the repository, or GitHub says it is public right now.

Security rules:

- Public visibility comes from GitHub on each check, never from stored flags.
- Admin status does not bypass the GitHub gate.
- The App installation's access to a private repository is never a user grant.
- The credential the server reads with stays on the server and is never sent in a response.
- A non-admin sees only their teams' directory grants and the directories above them needed to reach them.
- A directory the reader's grants reach only part of lists only its subdirectories to open; reading its files or history is `404 no-directory`.
- Treemap, Code, Search, Compare, Commits and Replay read a directory only where the grants reach all of it.
- Issues, Pull requests, Agents, Pulse and Commits' **All branches** need grants that reach the whole repository (`404 no-directory` otherwise).
- After each GitHub read, both gates are checked again before anything is sent.
- The server shares what it read from GitHub between readers, but checks each reader's access on every request.
- When GitHub refuses a later read (the App's permission withdrawn, or the repository or item gone), the shared copy is dropped and the next reader is refused the same way.
- The browser holds file contents in memory only while it shows them.

## What needs a GitHub token

The server reads with the reader's GitHub sign-in, else the repository App's installation, and a public repository may have neither.
A nonpublic repository is always read with the App's installation.

| View | Public repository without a token |
| --- | --- |
| Treemap, Code, Search, Compare, Replay | Works |
| Commits, a revision's history | Works |
| Commits, **All branches** and squash merges | Falls back to the revision's own history |
| Issues, Pull requests, Agents, Pulse | `403 github-token-required` |

For the App permissions a nonpublic repository needs, see [Issues and pull requests](#issues-and-pull-requests).

## Code, Search and Treemap

**Code** shows the directory's files, and **Search** searches their text, as in the [npm viewer](./npm-viewer.md).
**Treemap** draws the directory by file size.
While the files load, or where the directory is too large to open, the Treemap is drawn from GitHub's tree listing alone, so its cells open nothing.
That listing keeps the 75,000 files nearest the root, and the Treemap says so when it leaves some out.

## Directory limits

A directory is read whole, and its own limits are separate from a package's.

| Limit | Value |
| --- | --- |
| Files in the directory's tree | 80,000 |
| Bytes in the directory's tree | 256 MiB |
| Tar stream | 384 MiB |
| Tar entries | 160,000 |
| Files as JSON | 384 Mi characters |

Past any of them the answer is `413 directory-too-large`.
Code, Search and Compare then say why and list the subdirectories to open instead, while Treemap and Commits still work.

Symlinks may point anywhere inside the repository.
An absolute symlink, or one that climbs above the repository root, makes the directory `422 directory-unreadable`.

Directory loads share the npm viewer's load capacity, and a large directory takes more of it.
When it is full, the answer is `429 repository-busy`.

## Compare

**Compare** compares the directory with itself at another revision.
Its Overview lists the files added, removed and changed, and its Code shows them as a diff.
It shows none of a package's risk, alerts or dependencies.
Each side picks a branch, a tag or a commit, and **Swap** exchanges them.

## Activity

**Activity** shows what happens around the code, in six views, each with its own route: `commits`, `issues`, `pulls`, `agents`, `pulse` and `replay`.
It opens on the view last shown, or on Commits.
None of these views reads the directory's files, so they work where the directory is too large to open.

## Commits

**Commits** lists commits like `git log --oneline --decorate --graph`: short id, branches and tags, subject, authors and time, beside a lane graph.
Clicking a line opens that commit.

- **All branches** (the default) lists every branch, like `--all`.
- **Unmerged** lists the commits the default branch does not reach, like `git log --all --not <default>`.
- **Older commits** loads more, and loads on its own as the scroll nears the end.
- A pull request squashed into a listed commit is drawn as the merge it was, with its own commits on a lane.
- A directory below the root lists only the commits that touch it, without a graph.
- Repositories with more than 5,000 branches leave the rest out, and the tab says so.

A commit shows its author, then its co-authors from its `Co-authored-by:` trailers, then any agents its message marks (see [Agents](#agents)).
The server reads each commit message for these and keeps and answers only the names, never the message.

## Issues and pull requests

**Issues** and **Pull requests** show the repository's items as a grid of tiles, the most recently updated first.
**Open** and **Closed** pick which to show, each with its count; for pull requests, Closed includes merged.
A **Filter** matches every typed word against number, title, author, labels and branch.
Items load fifty at a time, and more load as the scroll nears the end.

A tile shows the title, number, author, age, labels and comment count, and for a pull request its branches, lines changed, review state and checks.
An open pull request's tile also shows its reviews:

- each reviewer's latest review, dimmed where it was on an earlier commit;
- Copilot's code review and agentic workflow (gh-aw) reviews, by their bots;
- Codex's review, from its summary comment: reviewed, reviewing, asked again or failed;
- open review threads, with the gravest badge (P0 to P3);
- **Unreviewed** where no review is on the latest commit.

A pull request author's own replies in their threads do not count as reviews.

Clicking a tile opens a popup with the description, linked items (what a pull request closes, or what closed an issue), commits, files changed, who merged it, its reviews and open threads, and **Open on GitHub**.
The description is shown as the Markdown written, never GitHub's HTML of it, and is shortened past 20,000 characters.
A pull request that changes a lockfile also shows the package versions it adds; see [dependency review](./dependency-review.md).

A nonpublic repository's items are read with its GitHub App installation, which needs these permissions (see [creating GitHub issues](./reports.md#creating-github-issues) for the App setup):

| Permission | Without it |
| --- | --- |
| **Pull requests: read** | The Pull requests tab fails with `502 github-status-403` and says so |
| **Checks: read** and **Commit statuses: read** | Tiles show no checks |

Where GitHub refuses only reviews, threads or comments, the tiles show none of them.

Other GitHub failures the tabs report:

| Error | Cause |
| --- | --- |
| `502 github-timeout` | GitHub took too long (it stops a query after ten seconds) |
| `502 github-status-403` | The token lacks a scope, or the App lacks a permission |
| `502 github-malformed` | GitHub answered with an error of no named type |
| `404 github-not-found` | No issue or pull request has that number |

GitHub's own error text is logged on the server only.

## Agents

**Agents** shows the work sessions agents did in the repository, in the same tiles, the most recently active first.
A session holds its tasks: the pull requests it opened, and the commits it pushed straight to the default branch without a pull request.
**All**, **Claude**, **Codex** and each app agent with sessions pick whose sessions show, and **Filter** matches title, author, branch, number, commit or session id.
Clicking a tile opens the session: its pull requests, issues, commits and branches, and a link to where it ran.

Agents are recognised by what they leave on GitHub:

| Agent | Recognised by |
| --- | --- |
| Claude | `https://claude.ai/code/session_…` or a `Claude-Session:` trailer; `Co-Authored-By: Claude … <noreply@anthropic.com>`; `Generated with [Claude Code]`; a commit Claude authored; a `claude/…` branch |
| Codex | `https://chatgpt.com/codex/tasks/task_…`; `Co-authored-by: Codex <codex@openai.com>`; a `codex/…` branch |
| Neo | A line starting with U+1F916 then `Generated with [Neo](`; account 274065190; a `neo/…` branch |
| Copilot | Account 198982749 (`Copilot`, `copilot-swe-agent`); a `copilot/…` branch |
| Dependabot | Account 49699333 (`dependabot`, `dependabot[bot]`); a `dependabot/…` branch |
| Cursor (commit lines only) | `Cursor Agent <cursoragent@cursor.com>` or a `cursor.com/agents?id=bc-…` link |
| Any of these | A pull request label naming the agent, alone or after `agent:` or `agent/` |

Everything that names one session joins it; otherwise one branch is one session, and each app agent's pull request is a session of its own.

Privacy and spoofing rules:

- Only an item's own texts are read: a pull request's body and its head and merge commit messages, a commit's message, and a branch's tip commit.
- Comments and issue bodies are never read, since anyone can name a session in a comment.
- Only what the texts tell (sessions, marks, fingerprints) is answered, never the texts.
- The server serves avatars only for the known agents' own GitHub Apps and accounts, and the browser never keeps a user's avatar.

Loading stops after a page that adds no session; **More** then reads on.

## Pulse

**Pulse** shows how the default branch moves over a **Week**, **Month**, **Quarter** or **Year**: one, four, thirteen or fifty-two weeks up to today, in GitHub's weeks (Sunday first, UTC).

- Figures: commits, contributors, pull requests merged and opened, issues closed and opened, and lines added and removed.
  Commits, pull requests and issues are compared with the same days of the week one period earlier.
- **Commits** and **Lines** plot each day or week; clicking a column scopes the contributors to it.
- **Contributors**: the top eight by commits, with their lines; clicking one filters the plots to them.
- **Pull requests** and **Issues**: the ten latest merged or opened, closed or opened, with a link to all on GitHub.
- **When commits are made**: commits by weekday and hour, in each author's own time zone.

Merge commits are left out.
While the year's commits are still being read, the tab shows its progress and offers **Read on** if it stalls.
A year of more than 10,000 commits is counted from GitHub's weekly statistics instead, so a week or a month then shows no lines and a day's contributors are its week's.
GitHub counts no lines at all for a repository of 10,000 commits or more.
While GitHub is still computing them, the tab says so and offers **Ask again**.

## Replay

**Replay** animates the revision's latest commits, as [Gource](https://gource.io) does.
Directories form a tree from the directory shown, with each directory's files as dots around it, coloured by file kind.
Each commit's author and co-authors fly to the files it changes, which show as added, modified or removed.

- **Last 100**, **Last 300** (the default) or **Last 1,000** picks how many commits play.
- Merges are left out, and commits play oldest first.
- **½×** to **8×** set the speed, and the track under the canvas plays, pauses and seeks.
- It starts playing as it opens, unless the reader asks for reduced motion.
- The starting tree is read up to 75,000 files; beyond that the replay is drawn in part and its summary says so.
- If a page of history fails, Replay says so and offers **Retry**.
