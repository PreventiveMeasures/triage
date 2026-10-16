# actions-scan

What calls for a look at a repository's GitHub Actions, for a reviewer: its workflows, the actions of its own they use, and every action and reusable workflow of another repository they name, read from their code and resolved on GitHub. Plain JavaScript, no DOM, no UI, as `risk/` is.

It is told on the managed server alone, as a part of a repository risk scan (`GET /api/admin/repositories/risk`, server-managed/repository-actions.ts), and shown on Manage → Repositories → Risk's Actions tab (ui/managed/repository-risk-actions.js).

## Asking

```js
import { keptSource, resolveAction, scanWorkflow, usesOfKey } from './actions-scan/index.js'

// A workflow's own findings, and what it names to resolve.
const { triggers, uses, findings } = scanWorkflow('workflow', text, {
  owner: 'org', // whose repository it is: a `uses:` of the same owner's, as of GitHub's own, is graded yellow unpinned, another's orange
  lockfiles: [{ path: 'web/package-lock.json', names: new Set(['eslint']) }], // what npx runs of the project's own, by where its step runs
})

// Each reference resolved on GitHub, its own code read in turn.
const resolved = await resolveAction(usesOfKey('actions/checkout@v4'), keptSource(source), { owner: 'org' })
```

`scanWorkflow('action', text)` reads an action's metadata (action.yml) as it reads a workflow: a composite action's steps, a Docker action's image, a JavaScript action's runtime. `source` is GitHub as the asker reads it (index.d.ts `ActionsSource`): the managed server's asks @preventive/upstream's client for a repository, its tags, a tag's commit, a branch's head and a file at a commit, and GitHub's compare API whether a commit is in a ref's history (server-managed/github-actions.ts). `keptSource` keeps what it answers for as long as it is held, a scan's: a repository's tags are asked once, however many of its references there are.

YAML is read as GitHub reads it, by @preventive/lockfile's parseYaml with `workflow` (`yaml.js`): a value left empty, `>` folded scalars, anchors and aliases, scalars over more than one line; a tag (`!!js/function` and all), a merge key, which GitHub doesn't read either, and a tab indenting are refused, a workflow holding one told unreadable (`workflow-unreadable`). What it reads is plain data alone: no tag makes code or any other object. Until a release of it reads workflows (PreventiveMeasures/libraries#238, on its main as of deedba5), its files are kept in `vendor/lockfile/` as they are there.

## What it tells

Each finding is `{ id, severity, line, … }`, `line` the file's, counting from 1, as GitHub's links to a line count; one of a resolved reference's own code with the `file` it is in. Severities are risk's (`risk/files/stamps.js`): `critical` red, `high` orange, `moderate` yellow, `low`, `notice`.

Where actions come from and which repositories they point at (`resolve.js`):

- `repo-missing`: a repository GitHub has none of, red, as anyone who takes its owner's name can publish one; yellow for the same owner's, which may only be one the asker can't read.
- `repo-moved`: renamed or transferred, orange: GitHub redirects the old name until someone takes it. The resolved line names where it is now.
- `repo-fork`, `repo-archived`: low.

Whether they pin a commit, and where they don't, whether it is a version expected (`findings.js`, `resolve.js`):

- `unpinned`: by a tag or a branch, not a full commit sha: orange, yellow for GitHub's own (`actions/…`, `github/…`) and the same owner's. `short-sha`: by a short sha, which GitHub reads a branch or tag named so as too, orange.
- `branch-ref`: a branch, which moves with every push, orange; `ambiguous-ref`: a tag and a branch of one name, orange; `ref-missing`: neither, yellow, as GitHub runs whichever is pushed first.
- `not-version`: a tag that is no version (`latest`, `stable`), yellow.
- `tag-off-release`: a major or minor tag (`v4`, `v4.2`) on a commit no release of its line (`v4.x.y`) is on, orange, as tags moved by whoever took a repository are; `tag-off-branch`: a tag's commit on none of the repository's branches, low, as a release's built files may well be.
- `outdated`: an older major line than the repository's latest release, low.

Where they pin a commit, whether it is the repository's own and a release:

- `imposter-commit`: in the history of none of the repository's branches and releases, red: GitHub serves a commit of any fork under the name of the repository it forks. It is looked for in its default branch, the latest release of each major line, and up to 10 other branches; `unverified-commit` where the repository has more branches than were looked at, orange.
- `commit-missing`: one GitHub has none of, orange.
- `untagged-commit`: in the repository's history, but no tag names it: no release, yellow.
- `comment-mismatch`: the version a comment beside it names (`# v4.1.1`, as Dependabot, Renovate, pinact and ratchet write one) isn't one of the tags on it, nor the line of one, orange. A commit's key holds its comment (`owner/repo@sha # v4.1.1`), so that each is held to its own.

What their steps run past a pin, a workflow's and each action's alike (`scripts/`):

- `fetched-package`: a package fetched and run as it resolves now. npx, `npm exec`, bunx and `bun x` run the project's own where it is installed: one a lockfile at or above the directory its step runs in locks (by its name, or the package known to give the program, `tsc` typescript's), once an install ran before it, in a step before or earlier in its script, is none; else orange, as `pnpm dlx`, pnpx, `yarn dlx`, `npm create`, a global install, pip, pipx, uvx, `go install`, `cargo install`, `gem install` and `deno run` are; yellow where a version names it, as its integrity is still whatever the registry has, or a variable does; a notice for pip, setuptools and wheel themselves. A Go module by its version is none (Go's checksum database holds it), a crate by its version built with `--locked` none too. In another repository's action, npx is held to whether an install ran before it alone, as the workspace it runs in isn't its own.
- `unlocked-install`: an install that resolves anew where package.json and the lockfile disagree (`npm install`, `npm update`, `pnpm install --no-frozen-lockfile`), yellow; low for Yarn's and Bun's, which Yarn 2 and later refuse to in CI on their own.
- `remote-script`: a script fetched and run as it is fetched (`curl … | sh`, `bash <(curl …)`, `sh -c "$(curl …)"`, `iex (irm …)`, or saved and then run), orange.
- `unpinned-image`: an image by a tag, not a digest (`docker://`, `container:`, `services:`, a Docker action's, `docker run`, a Dockerfile's `FROM`), yellow, orange with no tag or `latest`.
- `clone`: a repository cloned at whatever its branch has, low.

And what else lets them run code no one expected:

- `script-injection`: an expression anyone can write (an issue's or pull request's title and body, a comment, a branch's name, a commit's message) written into a script, `run:` or github-script's `script:`, orange; red where the workflow runs with the base repository's secrets for anyone (`pull_request_target`, `workflow_run`, `issue_comment`, …).
- `pwn-request`: a workflow on `pull_request_target` or `workflow_run` checking out the pull request's own code (`actions/checkout`'s `ref:` its head, `gh pr checkout`), red.
- `untrusted-artifact`: such a workflow on `workflow_run` taking the run's artifacts, which a fork writes, orange.
- `secrets-inherited`: another owner's reusable workflow handed every secret, orange.
- `hosts`: services a script names that malicious code sends what it takes to or fetches what it runs from, by risk's tags (`risk/files/hosts.js`): Exfiltration red, Remote orange, IP lookup yellow.
- `deprecated-runtime`: an action on a Node.js GitHub no longer runs actions on, low; `invalid-uses`, a `uses:` GitHub can't read, low; `action-missing`, no action.yml where a reference names, yellow.

A reference's own code is what it runs: a composite action's steps, a reusable workflow's jobs and a Docker action's Dockerfile, each read as a workflow is, and each reference it makes resolved in turn (`uses`), up to 4 deep and 1,000 a scan. A JavaScript action's code is not read, its runtime alone.

## Inside

- `uses.js`: what a `uses:` names, its pin, the version a comment beside it names, and its key.
- `workflow.js`: a workflow or an action's metadata read for its jobs, steps, scripts and images, each on its line.
- `findings.js`: a workflow's own findings; `dockerfile.js`, a Dockerfile's.
- `scripts/`: a script's commands (`shell.js`), what each fetches (`commands.js`, `packages.js`), graded (`grade.js`).
- `expressions.js`: what of an expression anyone can write, and a ref naming a pull request's code.
- `resolve.js`: a reference resolved on GitHub; `versions.js`, tags as versions.
- `yaml.js`: the YAML reader, vendored in `vendor/lockfile/` for now.

A quick read, not a shell's parse nor a full run: a command built as a script runs (`$x install`, `eval "$cmd"`), one in a function it defines, or a package an action's JavaScript fetches goes unseen. Labels to assist a reviewer, not a check to rely on.
