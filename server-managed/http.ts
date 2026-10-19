// HTTP router for the managed auth server. Mounts the GitHub OAuth flow plus
// the session endpoints + the mode probe; there is NO api/sync here (a managed
// server doesn't speak the e2e sync protocol yet). Every handler is async; the
// boot's `track()` keeps in-flight requests drainable on shutdown.
//
//   GET  /api/config             → { mode:'managed', managed:{ loginPath, cookieName }, session }  (public;
//        `session` is /api/auth/session's answer, null signed out, absent when it could not be read)
//   GET  /api/oauth/github/login → 302 to GitHub (+ state cookie)
//   GET  /api/oauth/github/callback → the OAuth hook (see github-oauth.ts)
//   GET  /api/auth/session       → { user, csrfToken } | 401
//   GET  /api/auth/profile       → { profile: { login, name, githubName, nameAccount, avatarAccount, accounts } }, the
//        GitHub accounts linked to the user's and which of them the displayed name and avatar come from | 401/403
//   POST /api/auth/profile       → CSRF, chooses those ({ name?, avatar? }: a linked account's id, null the sign-in one) | 400/401/403/404
//   DELETE /api/auth/profile/accounts/<id> → CSRF, unlinks a linked GitHub account | 401/403/404
//   GET  /api/oauth/github/link  → 302 to GitHub to link another account (+ state cookie); the callback lands on /my/profile
//   GET  /api/teams              → the current user's teams + their reports and bundles | 401
//   GET  /api/teams/<id>/fixes → PR/issue metadata from visible findings' stored Fix links
//   GET  /api/teams/<id>/reports → all reports and links filtered through this team | 401/404
//   GET  /api/teams/<id>/feed    → SSE notifications for visible triage and comments | 401/404
//   GET  /api/reports/<id>       → admin/manager report preview | 401/403/404
//   POST /api/reports/query      → admin/manager batch preview, with repository metadata | 400/401/403/404/503
//   GET  /api/reports/<id>/triage → triage entries (by finding id, shared across reports) for a viewable report's findings | 401/404
//   POST /api/reports/<id>/triage → write triage entries: admin, or ≥triage role + membership | 401/403/404
//   GET  /api/reports/<id>/triage/history?finding=<fid> → one visible finding's triage trail, newest first | 400/401/404
//   GET  /api/avatar/<id>[?own]  → cached avatar bytes by user id, of the account chosen on their profile (`own`: the
//        sign-in account's), or by linked account id; `app-<id>` or `user-<id>`, an agent's GitHub App's or account's (GITHUB_AGENTS) | 401/404
//   GET  /api/admin/users        → admin-only user list | 401/403
//   GET  /api/admin/history      → paginated activity (admin), team content activity (manage) | 401/403
//   POST /api/admin/set-role     → admin sets another user's role | 401/403/404
//   GET  /api/admin/repositories → admin repo list (each flagged selected) | 401/403
//   POST /api/admin/repositories/select → admin selects/deactivates a repo | 401/403
//   POST /api/admin/repositories/dependency-review → admin sets a repo's dependency review: enabled, the reviews each
//        version needs, and the commit its lockfiles' versions need none since | 400/401/403/404
//   GET /api/admin/repositories/impact → admin attached data summary
//   GET /api/admin/repositories/{browsable,refs,contents} → view or above, within the reader's team grants, + GitHub read access
//        (browsable: the names alone; these and the reads below are the code viewer's, open to every team member)
//   GET /api/admin/repositories/code?repoId=&ref=&path= → the files of a directory at a revision, within the reader's grants,
//        Brotli-encoded | 400/401/403/404/409/413/429/502
//   GET /api/admin/repositories/history?repoId=&ref=&path=&page=[&all=true[&from=]] → the commits a revision reaches, a page at a time,
//        or across the most recently updated branches, with the branches and tags naming them, then on from the commits `from`
//        names | 400/401/403/404/409/429/502
//   GET /api/admin/repositories/changes?repoId=&path=&shas= → the files each of the commits `shas` names (fifty at most)
//        adds, modifies, removes and renames within `path`, as `git log --name-status` lists them | 400/401/403/404/409/429/502
//   GET /api/admin/repositories/tree?repoId=&path=&commit= → the files commit `commit` holds within `path`, as many as
//        75,000, for Replay to start from | 400/401/403/404/409/429/502
//   GET /api/admin/repositories/issues?repoId=&kind=issues|pulls&state=open|closed[&after=] → a page of the repository's issues
//        or pull requests, the most recently updated first, with how many are open and closed | 400/401/403/404/409/429/502
//   GET /api/admin/repositories/agents?repoId=[&pulls=&commits=] → a page of what agents left: pull requests and commits to
//        the default branch no pull request merged, with issues, agents' branches and the app agents first | 400/401/403/404/409/429/502
//   GET /api/admin/repositories/item?repoId=&number= → an issue or pull request, as its popup shows it, with its
//        description's Markdown | 400/401/403/404/409/429/502
//   GET /api/admin/repositories/pull-dependencies?repoId=&number= → the package versions a pull request's npm, pnpm and
//        Yarn 1 lockfiles lock that they didn't at its merge base, an update's with those it was, by directory; with review=1, each's
//        review, where its repository reviews dependencies; with numbers=1,2,3 (twenty at most) in place of number, those of each,
//        { pulls }, one GitHub fails told { number, error } | 400/401/403/404/409/429/502
//   GET /api/admin/repositories/branch-dependencies?repoId= → the versions the default branch's lockfiles lock that want review, where
//        its review is in effect for the reader, GitHub not asked where it reviews none | 400/401/403/404/409/429/502
//   GET /api/admin/repositories/lockfiles?repoId= → the lockfiles of the default branch its dependency review reads, by their
//        paths, for its settings to name | 400/401/403/404/409/429/502
//   GET /api/admin/repositories/pulse?repoId=&weeks=1|4|13|52 → the default branch's commits and lines a week and a day over
//        the last year, its contributors and when in the period they commit, counted from its commits as Commits keeps them (how many are
//        read while they are), and the pull requests
//        merged and opened and the issues closed and opened in the last `weeks` weeks and the same days a period earlier | 400/401/403/404/409/429/502
//   GET /api/admin/repositories/pulse/items?repoId=&weeks=&from=[&to=&authors=] → those pull requests and issues of the days
//        `from` to `to` (YYYY-MM-DD, UTC; no `to`, on), and of any of `authors` (GitHub logins, comma-separated) | 400/401/403/404/409/429/502
//        History, issues, item, agents and pulse each carry `users`: the app's users and agents the GitHub accounts they
//        name are (github-users.ts), by login
//   POST /api/admin/repositories/remove → admin permanently removes a repo
//   GET  /api/admin/repositories/risk[?team=|?repo=] → admin: each connected repo's npm lockfiles, or a team's or one repo's,
//        their packages and what risk tells of each, Brotli-encoded ndjson as each is found; the reader leaving stops it | 400/401/403/404
//   GET  /api/admin/reports      → admin|manage list of uploaded reports | 401/403
//   POST /api/admin/reports      → admin|manage uploads a report (raw body) | 401/403/413
//   GET  /api/admin/reports/<id> → admin|manage downloads a stored report | 401/403/404
//   DELETE /api/admin/reports/<id> → admin|manage deletes a report | 401/403/404
//   POST /api/admin/reports/set-repo → admin|manage attaches/detaches a report's repo | 401/403/404
//   GET  /api/admin/reports/<id>/location → admin|manage live location suggestion | 401/403/404/503
//   GET  /api/bundles/<id>/{metadata,contents} → authorized encoded bytes | 401/404/422
//   GET  /api/bundles/<id>/advisories → published dependency advisories (security access) | 401/403/404
//   GET  /api/bundles/<id>/download → authorized original upload | 401/404
//   GET  /api/bundles/<id>/pretty?path=&hash= → one of its files pretty-printed, Brotli-encoded | 400/401/404/409/413/422/429
//   GET  /api/bundles/<id>/pretty?other= → the files that changed between it and another bundle, both sides' pretty-printed,
//        Brotli-encoded ndjson | 400/401/404/422/503
//   GET  /api/bundles/<id>/rename-diff?path=&hash=&other=&otherPath=&otherHash= → a JavaScript file diffed with another
//        bundle's, both pretty-printed, renamed names hidden, whitespace changes shown and hidden | 400/401/404/409/413/422/429/504
//   GET  /api/bundles/<id>/rename-diff?other=&scope= → every pair of its JavaScript files and another bundle's the viewer
//        diffs so, within a reason scope where given, Brotli-encoded ndjson | 400/401/404/422/503
//   GET  /api/bundles/<id>/type-only?other=&scope= → the files that changed between it and another bundle in types alone, as
//        @preventive/compare proves them, within a reason scope where given, Brotli-encoded ndjson | 400/401/404/422/503
//   GET  /api/admin/bundles      → admin all bundles; managers own/team bundles | 401/403
//   POST /api/admin/bundles      → admin|manage uploads a bundle (raw body) | 401/403/413
//   GET  /api/admin/bundles/<id> → admin|manage downloads a stored bundle | 401/403/404
//   DELETE /api/admin/bundles/<id> → admin|manage deletes a bundle | 401/403/404
//   POST /api/admin/bundles/set-repo → admin|manage attaches/detaches a bundle's repo | 401/403/404
//   GET  /api/admin/uploads/key  → admin|manage public key for sealed upload bodies | 401/403
//   GET  /api/admin/teams        → admin teams (+ members/repos) + pickers | 401/403
//   POST /api/admin/teams        → admin creates a team | 401/403/409
//   POST /api/admin/teams/rename → admin renames a team | 401/403/404/409
//   POST /api/admin/teams/set-hidden → admin hides/restores a team | 401/403/404
//   POST /api/admin/teams/delete → admin deletes a team | 401/403/404
//   POST /api/admin/teams/{set,remove}-repo   → admin links/unlinks a repo (+path) | 401/403/404
//   POST /api/admin/teams/{set,remove}-member → admin links/unlinks a user (+perms) | 401/403/404
//   POST /api/admin/teams/set-dependency-review → admin toggles dependency review publication for a team | 400/401/403/404
//   POST /api/admin/teams/set-npm-scopes → admin replaces a team's npm scopes | 400/401/403/404
//   GET/POST /api/npm/reviews → read private/team reviews; save, publish, revoke or continue a set | 400/401/403/404/409
//   POST /api/npm/reviews/discard → author discards an unpublished review and its file rows | 400/401/403/409
//   GET /api/npm/reviews/latest → latest own review for exact target bytes, across all bases | 400/401/403
//   GET /api/npm/reviews/team?teamId=&beforeTime=&beforeId= → the reviews published to a team, the latest first, for one who
//        reads them there | 400/401/404
//   GET  /api/npm/package?name=&version= → a published version's manifest and files | 400/401/404/413/429/502
//   GET  /api/npm/versions?name= → its dist-tags, versions, when each was published and its first was, and whether a team lists its scope | 400/401/404/429/502
//   GET  /api/npm/download?name=&version= → its tarball | 400/401/404/413/429/502
//   GET  /api/npm/stats?name= → its downloads over the last year and its GitHub repository's figures | 400/401/404/429/502
//   GET  /api/npm/advisories?name= → its advisories across every published version, npm's and its repository's | 400/401/404/429/502
//   GET  /api/npm/tags?name=&version= → the tags pointing to its publish commit | 400/401/404/429/502
//   GET  /api/npm/socket?name=&version= → Socket's scores and alerts for a public version | 400/401/404/429/502
//   GET  /api/npm/provenance?name=&version= → npm's provenance for a public version | 400/401/404/429/502
//   GET  /api/npm/pretty?name=&version= → every one of its files that needs it pretty-printed, Brotli-encoded ndjson | 400/401/404/413/429/502/503
//   GET  /api/npm/pretty?name=&version=&otherVersion= → the files that changed between it and another version, both sides'
//        pretty-printed, Brotli-encoded ndjson | 400/401/404/413/429/502/503
//   GET  /api/npm/pretty?name=&version=&path=&hash= → one of its files pretty-printed, Brotli-encoded | 400/401/404/409/413/422/429/502/503
//   GET  /api/npm/rename-diff?name=&version=&path=&hash=&otherVersion=&otherPath=&otherHash= → a JavaScript file diffed with
//        another version's, both pretty-printed, renamed names hidden, whitespace changes shown and hidden | 400/401/404/409/413/422/429/502/503/504
//   GET  /api/npm/rename-diff?name=&version=&otherVersion= → every pair of their JavaScript files the viewer diffs so,
//        Brotli-encoded ndjson | 400/401/404/413/429/502/503
//   GET  /api/npm/type-only?name=&version=&otherVersion= → the files that changed between two versions in types alone,
//        Brotli-encoded ndjson | 400/401/404/413/429/502/503
//   GET  /api/npm/delta?name=&version=&otherVersion= → the lines a version adds and removes against another, or `(empty)`, and
//        those but for declaration files changed in types alone, where any are, and whether binary files changed
//        | 400/401/404/413/422/429/502/503/504
//   GET  /api/npm/risk?name=&version=&otherVersion= → what calls for a look at a version, as risk tells it, against another where given | 400/401/404/413/429/502
//   POST /api/auth/logout        → same-origin + CSRF, drops the session (and any view)
//   POST /api/auth/view-as       → admin opens a read-only view as another user | 400/401/403/404
//   DELETE /api/auth/view-as     → ends the view (the view's CSRF token)
import { mergeLinkGroups } from './link-reports.ts'
import { backfillFindingIds, reportEntries } from '@preventive/report'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { REPOSITORY_READ_KEPT_MS, historyChangeStore, historyPageStore, historySquashStore, historyTreeStore, lockfileReadStore, npmDeltaStore, npmPublishTimeStore, npmVersionStore,
  ownKeptPrunes, pullDependencyStore, repositoryReadStore, reviewBaselineStore, riskLineStore, scanReadStore } from './npm-kept.ts'
import { type NpmDelta, keptNpmDeltas, npmDelta } from './npm-delta.ts'
import { ADVISORIES_TIMEOUT_MS, fetchBundleAdvisories } from './bundle-advisories.ts'
import { auditCache, auditedRepos, lastListing } from './upstream-cache.ts'
import type { BundleAdvisoryInventory } from './bundle-advisory-inventory.ts'
import { UPLOAD_CHUNK_BYTES, type UploadKind, deleteUpload, newUploadKey, openSessionUpload, putUploadPart, readUpload, uploadPublicKey, validUpload, validUploadPart } from './uploads.ts'
import { UPLOAD_SEAL_HEADER, maxSealedBytes } from '../common/managed/upload-seal.ts'
import { type BundleCache, type BundleCachePart, MAX_PACKAGE_INVENTORY_BYTES } from './bundle-cache.ts'
import type { CacheStorage } from './cache-storage.ts'
import { backfillBundleSummaries, bundleSummaries } from './bundle-catalog.ts'
import { type CatalogCommit, backfillBundleCommits, bundleCommits, cacheCommitDetails } from './bundle-commits.ts'
import { contentAccess } from './content-access.ts'
import type { BundleStore } from './bundle-store.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import type { AvatarStore, CachedAvatar } from './avatar-store.ts'
import type { BlobStore, OpenedBlob } from './blob-store.ts'
import { bundleFilePrefix, bundleIntegrity, bundleKind, bundleRepo, reportBundleHashes } from './bundle.ts'
import { resolveRepositoryImportLocation } from './repository-aliases.ts'
import type { ManagedConfig } from './config.ts'
import type { BundleBuildConditions, BundleProvenance, BundleReuse, ManagedBundle, ManagedDb, ManagedSession, ReportRecord, SelectedRepo, StoredUser, TriageEventRow } from './db.ts'
import type { OriginGate } from '../server-common/origin.ts'
import { isRole, roleAtLeast } from '../common/managed/roles.ts'
import { VISIBILITY_PERMISSIONS, parseTeamUserPermissions } from '../common/managed/permissions.ts'
import { filterReportData } from '../common/managed/report-filter.ts'
import type { TriageEntryPatch } from '../common/managed/triage.ts'
import { GITHUB_AGENTS } from '../common/managed/github-agents.ts'
import { MAX_FINDING_ID, MAX_TRIAGE_BODY_BYTES, MAX_TRIAGE_ENTRIES, MAX_TRIAGE_HISTORY, parseTriageEntryPatch } from '../common/managed/triage.ts'
import { reportRepoGithub } from '@preventive/report'
import { findingsRepository, loadManagedFindings, ownFileDirectory, readManagedReport } from '../common/managed/report-content.ts'
import type { ReportSourcesCache } from './report-sources.ts'
import { normalizeTeamPath } from './repo-path.ts'
import { DEFAULT_MANAGED_SCAN_MODEL, MANAGED_SCAN_MODELS } from '../common/managed/scan-models.ts'
import { CONFIG_PATH, type ManagedSessionInfo, type ServerInfo } from '../common/server-info.ts'
import { bundleCommitHash } from '../common/bundle-commit.js'
import { GithubApiError, collectRepos, fetchPublicRepository, installUrl, publicRepositoryName, repositoryInstallation } from './github-app.ts'
import { upstreamGithub } from './github-errors.ts'
import { createClient } from '@preventive/upstream/github.js'
import type { ConnectedRepo } from './github-app.ts'
import { canAddAnyPublicRepository, canAddRepositories, passesPublicRepositorySafeguard } from './repository-policy.ts'
import { RepositoryDiscovery } from './repository-discovery.ts'
import { RISK_KEPT_MS, SCAN_READ_KEPT_MS, type ScanProgress, repositoryRiskLines } from './repository-risk.ts'
import { WORKFLOWS_DIR } from './repository-actions.ts'
import { githubActionsSource } from './github-actions.ts'
import { type RepositoryEntry, createRepositoryBrowser, repositoryTreeFiles, scopedDirectory } from './repository-browser.ts'
import { type Lru, lru } from './lru.ts'
import { CALLBACK_PATH, LOGIN_PATH, OAuthError, buildLoginRedirect, cacheAvatar, ensureUserAccessToken, handleCallback } from './github-oauth.ts'
import { clearCookie, endSession, handOverSession, readSession, runRequestPresence, sessionIds } from './session.ts'
import { runTimed } from './request-timing.ts'
import { isExactVersion } from '@preventive/upstream/semver.js'
import { VIEW_AS_PATH, VIEW_ONLY_ERROR, clearViewCookie, endViewSession, runViewing, startViewSession, viewToken } from './view-as.ts'
import type { ActivityContext, ActivityInput } from './activity.ts'
import { acceptsReportMetadata } from './report-response.ts'
import { TeamReportsError, loadTeamAnnotations, loadTeamReportsResponse, loadTeamTreesResponse, recheckTeam, teamFindingIds, teamSnapshot, teamSourcePaths, teamWorkspaceFindingIds } from './team-reports.ts'
import { FINDING_CATALOG_PAGE_BYTES, FINDING_CATALOG_PAGE_COUNT, MAX_REPORT_QUERY_BYTES, MAX_REPORT_QUERY_COUNT } from './report-query.ts'
import { lookupFixes, storedFixUrls } from './github-pulls.ts'
import { lookupIssueLinks } from './github-issue-links.ts'
import { visibleManagedIssues } from './managed-issues.ts'
import { IssueError, MAX_ISSUE_BODY_BYTES, createGithubIssue, parseIssueContext, prepareGithubIssue } from './github-issues.ts'
import { ISSUE_LOGIN_PATH, isIssueOAuthCallback, issueLoginRedirect, issueOAuthCallback } from './github-issue-oauth.ts'
import { LINK_LOGIN_PATH, isLinkOAuthCallback, linkLoginRedirect, linkOAuthCallback } from './github-link-oauth.ts'
import type { ProfileChoice } from './github-links.ts'
import { withAppUsers } from './github-users.ts'
import { isBlobId } from './object-storage.ts'
import { attachmentDisposition, openLines, sendJson, sendLines, writeResponse, writeResponseParts } from './http-response.ts'
import { triageWireEntry } from './triage-response.ts'
import { handlePublicWorkspace } from './public-workspace.ts'
import { serveUserTeamFeed } from './team-feed.ts'
import { teamAppKey, teamAppStates, withWorkspaceSummary } from './team-app.ts'
import { hashToken, randomToken, safeEqual } from './crypto.ts'
import { canDeleteComment, parseCommentBody } from '../common/managed/comments.ts'
import { ManagedMutationError, reportReferenceSnapshot } from './management.ts'
import { BundleBuildError, buildRepositoryBundle, parseBundleBuild, withBundleBuildLease } from './bundle-build.ts'
import { NpmPackageError, type NpmReader, type NpmVersionDocument, type NpmVersionStore, VERSION_KEPT_MS, canReadPrivateNpm, npmFileRows, npmPublishTime, npmScopesCount, npmTarballFilename, readNpmVersion, readNpmVersions, readTogether } from './npm-packages.ts'
import { loadNpmFiles, loadNpmPackageBody, loadNpmTarball } from './npm-loads.ts'
import { loadRepositoryCodeBody, repositoryCodeFits } from './repository-code.ts'
import { type ChangesStore, type CommitChanges, type CommitTree, TREES_READ, changesAsked, changesWithin, directoryFiles, repositoryChanges } from './repository-changes.ts'
import { COAUTHORS_READ } from './commit-coauthors.ts'
import { type AllHeads, type HistoryCommit, type HistoryPages, MAX_HISTORY_PAGE, historyFrom, historyStarts, openPullHeads,
  repositoryAllHeads, repositoryAllHistory, repositoryHistory, repositoryRefTips } from './repository-history.ts'
import { type SquashedPull, type Squashes, squashedPulls } from './repository-squashes.ts'
import { AGENTS_READ_VERSION, COMMITS_CURSOR, repositoryAgents } from './repository-agents.ts'
import { ISSUES_CURSOR, ISSUES_READ_VERSION, repositoryIssues, repositoryItem } from './repository-issues.ts'
import { type GithubAsked, type ListedLockfile, type LockfileRead, type LockfileStore, MAX_LOCKED, PULL_DEPENDENCIES_READ, type PullCommits, type PullDependencies,
  type PullDependencyStore, eachOf, lockfileFormat, pullDependenciesAt } from './pull-dependencies.ts'
import { lockedAt, lockedIn, lockfilesAt } from './commit-lockfiles.ts'
import { MAX_REQUIRED_REVIEWS, type RepoDependencyReview, SINCE_COMMIT } from './repository-dependency-reviews.ts'
import { EVERY_LOCKFILE, heldTo, scopeOf } from './lockfile-scope.ts'
import { type ReviewBaselineStore, baselineFor, heldDependencies, reviewedDependencies, reviewedPackages } from './pull-dependency-reviews.ts'
import { formattedPull, withFormatted } from './dependency-review-comments.ts'
import type { ReviewedDependencies } from './reviewed-dependencies.ts'
import { commentReviews } from './pull-comment-reviews.ts'
import { PULSE_WEEKS, PULSE_YEAR_VERSION, type PulseStats, StatsPending, commitStats, defaultHead, periodStats, pulseSince, repositoryActivity, repositoryLines,
  repositoryStats, withLines, yearCommits } from './repository-pulse.ts'
import { type AgentMerges, agentCommits, agentMerges, directCommits, sameMerges } from './agent-merges.ts'
import { releaseCommits } from './release-commits.ts'
import { computeBundleDiff } from '../common/bundle-compare-diff.js'
import type { ReviewChange, ReviewContext, ReviewInput, ReviewedTarballs } from './dependency-reviews.ts'
import { allowedReviewVerdicts, isReviewableFile, npmReviewVerdictLimit, npmTakenDown } from '../common/dependency-reviews.js'
import { type NpmAdvisoryOptions, npmAdvisories, npmCommitTags, npmDownloads, npmGithubStats, npmKnown, npmLatestRepo, npmSocketReport } from './npm-insights.ts'
import { npmProvenance } from './npm-provenance.ts'
import { npmReadyScanDownload, npmReadyScanDownloads, npmRisk, npmRiskRemoved } from './npm-risk.ts'
import { NpmRiskError } from '../risk/index.js'
import { type PrettyCache, PrettyError, type PrettyRequest, compared, prettyRequest, prettyText } from './pretty-print.ts'
import { renameDiffOf, renameDiffRequest, renamedPairs } from './rename-diff.ts'
import { typeOnlyFiles } from './type-only.ts'
import { comparisonBody, emptySide, npmComparedSide } from './comparison.ts'
import { isNpmPackageName, isNpmPackageSpec, npmPackageScope } from '../common/managed/npm-packages.js'

const SESSION_PATH = '/api/auth/session'
const PROFILE_PATH = '/api/auth/profile'
const AVATAR_PREFIX = '/api/avatar/'
const LOGOUT_PATH = '/api/auth/logout'
const ADMIN_USERS_PATH = '/api/admin/users'
const ADMIN_HISTORY_PATH = '/api/admin/history'
const ADMIN_SCAN_MODELS_PATH = '/api/admin/scan/models'
const SET_ROLE_PATH = '/api/admin/set-role'
const ADMIN_REPOS_PATH = '/api/admin/repositories'
const BROWSABLE_REPOS_PATH = '/api/admin/repositories/browsable'
const REPO_REFS_PATH = '/api/admin/repositories/refs'
const REPO_CONTENTS_PATH = '/api/admin/repositories/contents'
const REPO_CODE_PATH = '/api/admin/repositories/code'
const REPO_HISTORY_PATH = '/api/admin/repositories/history'
const REPO_CHANGES_PATH = '/api/admin/repositories/changes'
const REPO_TREE_PATH = '/api/admin/repositories/tree'
const REPO_ISSUES_PATH = '/api/admin/repositories/issues'
const REPO_AGENTS_PATH = '/api/admin/repositories/agents'
const REPO_ITEM_PATH = '/api/admin/repositories/item'
const REPO_PULL_DEPENDENCIES_PATH = '/api/admin/repositories/pull-dependencies'
const REPO_BRANCH_DEPENDENCIES_PATH = '/api/admin/repositories/branch-dependencies'
const REPO_LOCKFILES_PATH = '/api/admin/repositories/lockfiles'
const REPO_PULSE_PATH = '/api/admin/repositories/pulse'
const REPO_PULSE_ITEMS_PATH = '/api/admin/repositories/pulse/items'
const SELECT_REPO_PATH = '/api/admin/repositories/select'
const REPO_DEPENDENCY_REVIEW_PATH = '/api/admin/repositories/dependency-review'
const ADD_PUBLIC_REPO_PATH = '/api/admin/repositories/add-public'
const CONNECT_REPO_APP_PATH = '/api/admin/repositories/connect-app'
const REPO_IMPACT_PATH = '/api/admin/repositories/impact'
const REMOVE_REPO_PATH = '/api/admin/repositories/remove'
const REPO_RISK_PATH = '/api/admin/repositories/risk'
const ADMIN_REPORTS_PATH = '/api/admin/reports'
const REPORT_SET_REPO_PATH = '/api/admin/reports/set-repo'
const REPORT_SET_VISIBLE_PATH = '/api/admin/reports/set-visible'
const REPORT_PREFIX = '/api/admin/reports/'
const ADMIN_BUNDLES_PATH = '/api/admin/bundles'
const BUNDLE_CREATE_PATH = '/api/admin/bundles/create'
const BUNDLE_SET_REPO_PATH = '/api/admin/bundles/set-repo'
const BUNDLE_SET_VISIBLE_PATH = '/api/admin/bundles/set-visible'
const BUNDLE_PREFIX = '/api/admin/bundles/'
const MY_TEAMS_PATH = '/api/teams'
const MY_REPORT_PREFIX = '/api/reports/'
const REPORT_QUERY_PATH = '/api/reports/query'
const MY_REPORT_TRIAGE_SUFFIX = '/triage'
const MY_REPORT_TRIAGE_HISTORY_SUFFIX = '/triage/history'
const ADMIN_TEAMS_PATH = '/api/admin/teams'
const TEAM_DELETE_PATH = '/api/admin/teams/delete'
const TEAM_RENAME_PATH = '/api/admin/teams/rename'
const TEAM_SET_HIDDEN_PATH = '/api/admin/teams/set-hidden'
const TEAM_SET_REPO_PATH = '/api/admin/teams/set-repo'
const TEAM_REMOVE_REPO_PATH = '/api/admin/teams/remove-repo'
const TEAM_SET_MEMBER_PATH = '/api/admin/teams/set-member'
const TEAM_REMOVE_MEMBER_PATH = '/api/admin/teams/remove-member'
const TEAM_SET_NPM_SCOPES_PATH = '/api/admin/teams/set-npm-scopes'
const NPM_PACKAGE_PATH = '/api/npm/package'
const NPM_VERSIONS_PATH = '/api/npm/versions'
const NPM_DOWNLOAD_PATH = '/api/npm/download'
const NPM_STATS_PATH = '/api/npm/stats'
const NPM_ADVISORIES_PATH = '/api/npm/advisories'
const NPM_TAGS_PATH = '/api/npm/tags'
const NPM_SOCKET_PATH = '/api/npm/socket'
const NPM_PROVENANCE_PATH = '/api/npm/provenance'
const NPM_PRETTY_PATH = '/api/npm/pretty'
const NPM_RENAME_DIFF_PATH = '/api/npm/rename-diff'
const NPM_TYPE_ONLY_PATH = '/api/npm/type-only'
const NPM_COMPARISON_PATH = '/api/npm/comparison'
const NPM_RISK_PATH = '/api/npm/risk'
const NPM_DELTA_PATH = '/api/npm/delta'
const NPM_DELTAS_PATH = '/api/npm/deltas'
// What risk's errors (risk/npm/registry.js NpmRiskError) are answered as: npm
// having no such package or version, or a tarball unpacking past risk's
// bounds; npm failing otherwise a 502.
const NPM_RISK_STATUS: Partial<Record<string, number>> = { 'package-not-found': 404, 'version-not-found': 404, 'package-too-large': 413 }
// A risk failure answered with its code alone, as risk's status for it (NPM_RISK_STATUS, else 502), its cause
// logged where it is the server's or npm's, not the reader's (a 5xx), for the logs to say why.
function sendRiskError(res: ServerResponse, err: NpmRiskError) {
  const status = NPM_RISK_STATUS[err.code] ?? 502
  if (status >= 500) console.error(`managed: npm risk failed (${err.code}):`, err.message)
  sendJson(res, status, { error: err.code })
}
const NPM_PATHS = new Set([NPM_PACKAGE_PATH, NPM_VERSIONS_PATH, NPM_DOWNLOAD_PATH, NPM_STATS_PATH, NPM_ADVISORIES_PATH, NPM_TAGS_PATH, NPM_SOCKET_PATH, NPM_PROVENANCE_PATH, NPM_PRETTY_PATH,
  NPM_RENAME_DIFF_PATH, NPM_TYPE_ONLY_PATH, NPM_RISK_PATH, NPM_COMPARISON_PATH, NPM_DELTA_PATH])
// How long an npm response may go unread before its connection is dropped.
const NPM_RESPONSE_IDLE_MS = 60_000
const MAX_TEAM_NAME = 100
// Managed data routes, and with them the authentication routes, which an
// admin's view as another user covers. Other paths fall through to a combined
// e2e server, whose own authentication a view never touches.
const MANAGED_DATA_PREFIXES = ['/api/admin', '/api/reports', '/api/bundles', '/api/teams', '/api/avatar', '/api/github', '/api/npm']
const VIEW_PREFIXES = [...MANAGED_DATA_PREFIXES, '/api/auth', '/api/oauth']
const underPrefix = (path: string, prefixes: readonly string[]) => prefixes.some(prefix => path === prefix || path.startsWith(prefix + '/'))

async function handleWorkspaceFixes(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, teamId: string, reportId: string | null): Promise<void> {
  const s = await readWorkspaceSession(res, deps, cookie, { handed: true })
  if (!s) return
  const snapshot = await teamSnapshot(deps.db, s.session.id, teamId, reportId)
  const ids = [...await teamWorkspaceFindingIds(deps.db, deps.reportStore, snapshot)]
  const manualUrls = storedFixUrls(await deps.db.listTriageFixes(ids))
  const storedIssues = await deps.db.listManagedIssues(ids)
  const issues = visibleManagedIssues(storedIssues, snapshot)
  const visibleIds = new Set(issues.map(issue => issue.findingId))
  const urls = [...new Set([...manualUrls, ...issues.flatMap(issue => [issue.issueUrl!, ...(issue.autoFixUrl ? [issue.autoFixUrl] : [])])])]
  await recheckTeam(deps.db, s.session.id, snapshot)
  const result = issues.length > 0
    ? await lookupIssueLinks(deps.config, deps.db, snapshot, urls, storedIssues.filter(issue => visibleIds.has(issue.findingId)))
    : { fixes: await lookupFixes(deps.config, deps.db, snapshot, urls), updates: [] }
  // Cold report reads, token refresh and upstream batches can outlive changes
  // to security/links, team grants, publication, sessions or the Fix links.
  const currentUrls = storedFixUrls(await deps.db.listTriageFixes(ids))
  if (await readWorkspaceSession(res, deps, cookie) == null) return
  await recheckTeam(deps.db, s.session.id, snapshot)
  if (JSON.stringify(currentUrls) !== JSON.stringify(manualUrls)) {
    sendJson(res, 404, { error: 'workspace-changed' }); return
  }
  if (result.updates.length > 0 && !await deps.db.applyManagedIssueFixes(s.session.id, snapshot, result.updates)) {
    sendJson(res, 404, { error: 'workspace-changed' }); return
  }
  sendJson(res, 200, { fixes: result.fixes })
}

async function handleWorkspaceIssue(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps,
  cookie: string | undefined, teamId: string, query: URLSearchParams): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') { send405(res, 'GET, POST'); return }
  const s = req.method === 'GET' ? await readWorkspaceSession(res, deps, cookie, { handed: true }) : await checkMutation(req, res, deps, cookie, { handed: true })
  if (!s) return
  if (!roleAtLeast(s.user.role, 'view')) { sendJson(res, 403, { error: 'forbidden' }); return }
  let body: unknown = Object.fromEntries(query)
  if (req.method === 'POST') {
    try { body = await readJsonBody(req, MAX_ISSUE_BODY_BYTES) }
    catch { sendJson(res, 400, { error: 'bad-body' }); return }
  }
  const context = parseIssueContext(body)
  const prepared = await prepareGithubIssue(deps.config, deps.db, deps.reportStore, s.session, teamId, context)
  await prepared.recheck()
  if (req.method === 'POST' && prepared.mode === 'api') {
    sendJson(res, 201, await createGithubIssue(prepared, body)); return
  }
  sendJson(res, 200, { mode: prepared.mode, labels: prepared.labels,
    ...(prepared.mode === 'existing' ? { url: prepared.url } : {}),
    ...(prepared.mode === 'pending' ? { repositoryUrl: prepared.repositoryUrl } : {}),
    ...(prepared.mode === 'authorize' || prepared.mode === 'permissions' ? { authorizationPath: prepared.authorizationPath } : {}) })
}

function activity(deps: ManagedHttpDeps, user: StoredUser, kind: ActivityInput['kind'], action: string, context: Pick<ActivityInput, 'repo' | 'reportId' | 'bundleId' | 'report' | 'repoId' | 'repoDirectory'> = {}): Promise<void> {
  return deps.db.recordActivity({ kind, actor: user.login, actorId: user.id, action, ...context }, Date.now())
}

function repositoryName(deps: ManagedHttpDeps, repoId: number | null | undefined): Promise<string | null> {
  return repoId == null ? Promise.resolve(null) : deps.db.getRepoFullName(repoId)
}

// Workspace history is authorized BEFORE filtering, counting, or paging.
// Managers get content activity for their currently accessible team content;
// even the displayed report context must come from those accessible reports.
async function handleHistory(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams): Promise<void> {
  const s = await readManageSession(res, deps, cookie, { handed: true })
  if (s == null) return
  const page = Number(query.get('page') ?? 1)
  const limit = Number(query.get('limit') ?? 100)
  const kind = query.get('kind') ?? 'all'
  const search = (query.get('q') ?? '').trim()
  const repo = query.get('repo') ?? ''
  const actor = query.get('actor') ?? ''
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !['all', 'triage', 'upload', 'visibility', 'access', 'repository', 'delete'].includes(kind) || search.length > 500
    || repo.length > 500 || actor.length > 500) {
    sendJson(res, 400, { error: 'bad-request' }); return
  }
  let contexts: ActivityContext[] | null = null
  if (s.user.role !== 'admin') {
    const findings = new Map<string, ActivityContext>()
    const reports = kind === 'all' || kind === 'triage' ? await deps.db.listActivityReports(s.user.id) : []
    // Every report's record in one read, as visibleFindingIds reads each one's.
    const snapshot = reports.length > 0 ? await deps.db.getReportAccessSnapshot(s.session.id, Date.now(), reports.map(report => report.reportId)) : { reports: [] }
    if (snapshot == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
    const records = new Map(snapshot.reports.map(record => [record.id, record]))
    for (const report of reports) {
      const record = records.get(report.reportId)
      if (record == null) continue
      for (const finding of await reportFindingIds(deps, record, record.repo.github)) {
        if (!findings.has(finding)) findings.set(finding, { finding, ...report })
      }
    }
    contexts = [...findings.values()]
  }
  sendJson(res, 200, await deps.db.listActivity({ page, limit, kind, query: search, repo, actor, contexts, userId: s.user.id }))
}

export interface ManagedHttpDeps {
  config: ManagedConfig
  db: ManagedDb
  avatarStore: AvatarStore
  reportStore: BlobStore
  bundleStore: BundleStore
  bundleCache?: BundleCache
  reportSourcesCache?: ReportSourcesCache
  prettyCache?: PrettyCache
  // The public npm cache, where risk keeps public packages' assessments (npm-risk.ts).
  npmCacheStorage?: CacheStorage
  uploadStore?: BlobStore
  originGate: OriginGate
  isShuttingDown: () => boolean
  track: (p: Promise<unknown>) => void
  // Serverless (Vercel's): keeps the invocation alive for work that goes on
  // past its answer, as a kept read read again behind it does.
  waitUntil?: (p: Promise<unknown>) => void
  // Combined boot delegates unmatched paths to e2e and overrides discovery.
  serveStatic?: (req: IncomingMessage, res: ServerResponse) => boolean
  next?: Handler
  serverInfo?: ServerInfo
  // The reviewed dependencies the host registered, as the server was
  // assembled (reviewed-dependencies.ts).
  reviewedDependencies?: ReviewedDependencies
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

function send405(res: ServerResponse, allow: string): void {
  sendJson(res, 405, { error: 'method-not-allowed' }, { allow })
}

function firstHeader(v: string | string[] | undefined): string | null {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.length > 0) return v[0] ?? null
  return null
}

// `key` is the image chosen for `id`; one not cached falls back to `id`'s own.
// A user's is never kept by the browser, as it changes with their profile.
async function serveAvatar(res: ServerResponse, avatarStore: AvatarStore, id: string, key = id, cacheControl = 'no-store'): Promise<void> {
  sendAvatar(res, await avatarStore.get(key) ?? (key === id ? null : await avatarStore.get(id)), cacheControl)
}

function sendAvatar(res: ServerResponse, avatar: CachedAvatar | null, cacheControl = 'no-store'): void {
  if (avatar == null) { sendJson(res, 404, { error: 'no-avatar' }); return }
  res.writeHead(200, {
    'content-type': avatar.contentType,
    'content-length': String(avatar.bytes.length),
    'x-content-type-options': 'nosniff',
    'cache-control': cacheControl,
  })
  res.end(avatar.bytes)
}

// The avatars `/api/avatar/app-<id>` and `/api/avatar/user-<id>` serve, these
// alone: those the app draws agents by (GITHUB_AGENTS), on the Agents tab and
// wherever their work shows. Each is fetched from GitHub once and
// kept, under a key no user's, a v4 UUID, can be: an app's, `…-0000-<id>`,
// an account's, `…-0001-<id>`.
const AGENT_AVATARS: ReadonlySet<string> = new Set(Object.values(GITHUB_AGENTS).flatMap(agent => 'avatar' in agent ? [agent.avatar] : []))
const AGENT_AVATAR = /^(app|user)-([1-9]\d{0,11})$/u
// An agent's mark is a public GitHub image that never changes with anyone's
// profile, drawn on every tile and comment by it: kept by the browser a day,
// for it alone.
const AGENT_AVATAR_CACHE = 'private, max-age=86400'

async function serveAgentAvatar(res: ServerResponse, avatarStore: AvatarStore, avatar: string): Promise<void> {
  const [, kind, id] = AGENT_AVATAR.exec(avatar)!
  const key = `00000000-0000-0000-000${kind === 'app' ? 0 : 1}-${id!.padStart(12, '0')}`
  // Read once where it is kept; read again only past fetching it.
  const kept = await avatarStore.get(key)
  if (kept != null) { sendAvatar(res, kept, AGENT_AVATAR_CACHE); return }
  await cacheAvatar(avatarStore, key, `https://avatars.githubusercontent.com/${kind === 'app' ? 'in' : 'u'}/${id}`, globalThis.fetch)
    .catch((err) => { console.warn('managed: agent avatar caching failed:', err) })
  await serveAvatar(res, avatarStore, key, key, AGENT_AVATAR_CACHE)
}

const MAX_JSON_BODY_BYTES = 4096

// Buffer the request body, aborting (and throwing 'too-large') once it exceeds
// `maxBytes` — bounds memory on the JSON mutations (small) and the report
// upload (config.maxReportBytes) alike.
async function readBodyBytes(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const c = chunk as Buffer
    size += c.length
    if (size > maxBytes) { req.destroy(); throw new Error('too-large') }
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

// A file upload's content, opening a body the browser sealed to this session
// (common/managed/upload-seal.ts). Link reports are never sent in parts; the
// parts of one sent in them are deleted behind its answer.
async function readUploadBody(req: IncomingMessage, deps: ManagedHttpDeps, session: ManagedSession, kind: UploadKind | 'links'): Promise<Buffer> {
  const maxBytes = kind === 'bundles' ? deps.config.maxBundleBytes : deps.config.maxReportBytes
  const sealed = req.headers[UPLOAD_SEAL_HEADER] !== undefined
  const limit = sealed ? maxSealedBytes(maxBytes) : maxBytes
  let bytes
  if (kind === 'links' || req.headers['x-upload-id'] == null) bytes = await readBodyBytes(req, limit)
  else if (deps.uploadStore) {
    bytes = await readUpload(deps.uploadStore, req, session.id, kind, limit, cleanup => { deps.track(cleanup); deps.waitUntil?.(cleanup) })
  }
  else throw new Error('bad-upload')
  return sealed ? await openSessionUpload(session.uploadKey, bytes, maxBytes) : bytes
}

// GET /api/admin/uploads/key — the session's upload public key, created on
// first use. Only this session's server-side private key opens what is sealed to it.
async function handleUploadKey(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  if (req.method !== 'GET') { send405(res, 'GET'); return }
  const s = await readManageSession(res, deps, cookie, { handed: true })
  if (!s) return
  const key = s.session.uploadKey ?? await deps.db.ensureSessionUploadKey(s.session.id, newUploadKey())
  if (!key) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  sendJson(res, 200, { key: uploadPublicKey(key) })
}

async function handleUploadPart(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, path: string) {
  const cancel = req.method === 'DELETE'
  if (req.method !== 'POST' && !cancel) { send405(res, 'POST, DELETE'); return }
  const s = await checkMutation(req, res, deps, cookie, { handed: true })
  if (!s || !requireManageRole(res, s.user)) return
  if (!deps.uploadStore) { sendJson(res, 404, { error: 'not-found' }); return }
  const match = /^\/api\/admin\/uploads\/(reports|bundles)\/([^/]+)(?:\/(0|[1-9][0-9]*))?$/u.exec(path)
  if (!match || (cancel ? match[3] !== undefined : match[3] === undefined)) { sendJson(res, 400, { error: 'bad-upload' }); return }
  const id = match[2]!, kind = match[1] as UploadKind
  if (cancel) {
    const count = Number(req.headers['x-upload-parts'])
    if (!validUpload(id, count)) { sendJson(res, 400, { error: 'bad-upload' }); return }
    await deleteUpload(deps.uploadStore, s.session.id, kind, id, count)
    sendJson(res, 200, { ok: true }); return
  }
  const index = Number(match[3])
  const maxBytes = kind === 'reports' ? deps.config.maxReportBytes : deps.config.maxBundleBytes
  const discard = async () => {
    if (validUpload(id, index + 1)) {
      await deleteUpload(deps.uploadStore!, s.session.id, kind, id, index + 1).catch(err => console.warn('managed: upload cleanup failed:', err))
    }
  }
  if (!validUploadPart(id, index, maxBytes)) { await discard(); sendJson(res, 400, { error: 'bad-upload' }); return }
  let bytes
  try { bytes = await readBodyBytes(req, Math.min(UPLOAD_CHUNK_BYTES, maxSealedBytes(maxBytes))) }
  catch { await discard(); sendJson(res, 413, { error: 'too-large' }); return }
  if (bytes.length === 0) { await discard(); sendJson(res, 400, { error: 'empty' }); return }
  if (await manageMutation(req, res, deps, cookie) == null) return
  await putUploadPart(deps.uploadStore, s.session.id, kind, id, index, bytes)
  sendJson(res, 200, { ok: true })
}

// `maxBytes` overrides the small default for the one endpoint whose JSON body
// legitimately grows (triage entry batches).
async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const buf = await readBodyBytes(req, maxBytes)
  return JSON.parse(buf.toString('utf8') || 'null')
}

// The router enforces same-origin for every request. A mutation also needs an
// authenticated session whose CSRF token matches the X-CSRF-Token header.
// Returns the session, or null after having already sent the 401/403. An
// admin's view as another user writes nothing; `view` admits only the
// endpoints that end it.
async function checkMutation(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, { view = false, handed = false } = {}): Promise<{ session: ManagedSession; user: StoredUser } | null> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now(), { handed })
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return null }
  const csrf = firstHeader(req.headers['x-csrf-token'])
  if (csrf == null) { sendJson(res, 403, { error: 'csrf-missing' }); return null }
  if (!safeEqual(csrf, s.session.csrfToken)) { sendJson(res, 403, { error: 'csrf-mismatch' }); return null }
  if (s.session.viewer && !view) { sendViewOnly(res); return null }
  return s
}

function sendViewOnly(res: ServerResponse): void {
  sendJson(res, 403, { error: VIEW_ONLY_ERROR })
}

// Reads stay available while an admin views as another user. Everything else
// is refused before dispatch, except ending the view or signing out, and the
// batch report preview, a POST without effects. Issue authorization would
// grant GitHub access on the viewed user's behalf, and linking an account
// would link it to the viewed user.
function viewAllows(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') return path !== ISSUE_LOGIN_PATH && path !== LINK_LOGIN_PATH
  return (method === 'DELETE' && path === VIEW_AS_PATH) || (method === 'POST' && (path === LOGOUT_PATH || path === REPORT_QUERY_PATH))
}

// POST /api/auth/logout — drop the session (same-origin + CSRF), which also
// ends a view opened from it.
async function handleLogout(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') { send405(res, 'POST'); return }
  const s = await checkMutation(req, res, deps, cookie, { view: true })
  if (s == null) return
  await endSession(deps.config, deps.db, cookie)
  const cleared = clearCookie(deps.config.sessionCookieName, deps.config.cookieSecure)
  res.writeHead(204, { 'set-cookie': s.session.viewer ? [cleared, clearViewCookie(deps.config)] : cleared, 'cache-control': 'no-store' })
  res.end()
}

// POST /api/auth/view-as — an admin opens a read-only view as another user
// (body { userId }); DELETE ends it. Viewing as oneself is refused.
async function handleViewAs(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const method = req.method ?? 'GET'
  if (method === 'DELETE') {
    if (await checkMutation(req, res, deps, cookie, { view: true }) == null) return
    await endViewSession(deps.config, deps.db, cookie)
    res.writeHead(204, { 'set-cookie': clearViewCookie(deps.config), 'cache-control': 'no-store' })
    res.end(); return
  }
  if (method !== 'POST') { send405(res, 'POST, DELETE'); return }
  const s = await checkMutation(req, res, deps, cookie)
  if (s == null) return
  if (s.user.role !== 'admin') { sendJson(res, 403, { error: 'forbidden' }); return }
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const userId = (body as { userId?: unknown } | null)?.userId
  if (typeof userId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  if (userId === s.user.id) { sendJson(res, 400, { error: 'cannot-view-as-self' }); return }
  const target = await deps.db.getUser(userId)
  if (!target) { sendJson(res, 404, { error: 'not-found' }); return }
  // The insert itself rechecks the admin session and role.
  const setCookie = await startViewSession(deps.config, deps.db, s.session, userId, Date.now())
  if (setCookie == null) { sendJson(res, 403, { error: 'forbidden' }); return }
  await activity(deps, s.user, 'access', `viewed as ${target.login}`)
  res.writeHead(204, { 'set-cookie': setCookie, 'cache-control': 'no-store' })
  res.end()
}

// GET /api/auth/profile — the user's profile (github-links.ts). POST chooses
// the accounts their displayed name and avatar come from. Workspace access is
// required: the accounts a user links are reserved for them.
async function handleProfile(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const method = req.method ?? 'GET'
  if (method === 'GET') {
    const s = await readWorkspaceSession(res, deps, cookie)
    if (s) await sendProfile(res, deps, s.user.id)
    return
  }
  if (method !== 'POST') { send405(res, 'GET, POST'); return }
  const s = await profileMutation(req, res, deps, cookie)
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const choice = parseProfileChoice(body)
  if (choice == null) { sendJson(res, 400, { error: 'bad-request' }); return }
  await deps.db.setProfileChoice(s.session.id, choice, Date.now())
  await sendProfile(res, deps, s.user.id)
}

// DELETE /api/auth/profile/accounts/<id> — unlink one of the user's linked
// GitHub accounts, which may then sign in or register again.
async function handleUnlinkAccount(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  if ((req.method ?? 'GET') !== 'DELETE') { send405(res, 'DELETE'); return }
  const s = await profileMutation(req, res, deps, cookie)
  if (s == null) return
  const link = await deps.db.unlinkGithubAccount(s.session.id, id, Date.now())
  if (link == null) { sendJson(res, 404, { error: 'no-account' }); return }
  await deps.avatarStore.delete(link.id).catch((err) => { console.warn('managed: linked avatar removal failed:', err) })
  await activity(deps, s.user, 'access', `unlinked GitHub account @${link.login}`)
  await sendProfile(res, deps, s.user.id)
}

async function profileMutation(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<{ session: ManagedSession; user: StoredUser } | null> {
  const s = await checkMutation(req, res, deps, cookie)
  if (s != null && !roleAtLeast(s.user.role, 'view')) { sendJson(res, 403, { error: 'forbidden' }); return null }
  return s
}

async function sendProfile(res: ServerResponse, deps: ManagedHttpDeps, userId: string): Promise<void> {
  const profile = await deps.db.getProfile(userId)
  if (profile == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  sendJson(res, 200, { profile })
}

// { name?, avatar? }, each a linked account's id or null; at least one.
function parseProfileChoice(body: unknown): ProfileChoice | null {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return null
  const choice: ProfileChoice = {}
  for (const key of ['name', 'avatar'] as const) {
    if (!Object.hasOwn(body, key)) continue
    const value = (body as Record<string, unknown>)[key]
    if (value !== null && (typeof value !== 'string' || !isBlobId(value))) return null
    choice[key] = value
  }
  return Object.keys(choice).length > 0 ? choice : null
}

// POST /api/admin/set-role — an admin sets ANOTHER user's role. Admin-only, and
// refused for the caller's own id so an admin can't drop their own admin (keeps
// at least one admin).
async function handleSetRole(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') { send405(res, 'POST'); return }
  const s = await checkMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  if (s.user.role !== 'admin') { sendJson(res, 403, { error: 'forbidden' }); return }
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const userId = (body as { userId?: unknown } | null)?.userId
  const role = (body as { role?: unknown } | null)?.role
  if (typeof userId !== 'string' || !isRole(role)) { sendJson(res, 400, { error: 'bad-request' }); return }
  if (userId === s.user.id) { sendJson(res, 403, { error: 'cannot-change-own-role' }); return }
  const target = await deps.db.getUser(userId)
  // A caller can hold the body open while their admin access is revoked.
  if (await readAdminSession(res, deps, cookie) == null) return
  const ok = await deps.db.setUserRole(userId, role)
  if (!ok) { sendJson(res, 404, { error: 'not-found' }); return }
  if (target?.role !== role) await activity(deps, s.user, 'access', `changed ${target?.login ?? userId}'s role to ${role}`)
  sendJson(res, 200, { ok: true })
}

// admin OR manage — the roles allowed into the management pages (repositories,
// reports), matching the sidebar account-menu gate. Sends 403 + returns false
// otherwise.
function requireManageRole(res: ServerResponse, user: StoredUser): boolean {
  if (user.role === 'admin' || user.role === 'manage') return true
  sendJson(res, 403, { error: 'forbidden' })
  return false
}

// A read endpoint open to admin|manage: resolve the session (401 if absent),
// then gate on the role (403). Returns the session, or null after the response
// was already sent. No CSRF — reads aren't mutations (cf. /api/admin/users).
async function readManageSession(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, { handed = false } = {}): Promise<{ session: ManagedSession; user: StoredUser } | null> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now(), { handed })
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return null }
  if (!requireManageRole(res, s.user)) return null
  return s
}

async function readAdminSession(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, { handed = false } = {}): Promise<{ session: ManagedSession; user: StoredUser } | null> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now(), { handed })
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return null }
  if (s.user.role !== 'admin') { sendJson(res, 403, { error: 'forbidden' }); return null }
  return s
}

async function readWorkspaceSession(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, { handed = false } = {}): Promise<{ session: ManagedSession; user: StoredUser } | null> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now(), { handed })
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return null }
  if (!roleAtLeast(s.user.role, 'view')) { sendJson(res, 403, { error: 'forbidden' }); return null }
  return s
}

// Who am I? While an admin views as another user, that user, plus the admin
// as `viewer`. A view that has ended (with the admin's session or role, or the
// viewed account) is cleared, returning to the own session. Null signed out.
// `dependencyReview` where they publish dependency reviews to some team.
async function currentSession(config: ManagedConfig, db: ManagedDb, cookie: string | undefined): Promise<{ body: ManagedSessionInfo | null; headers: Record<string, string> }> {
  const now = Date.now()
  let s = await readSession(config, db, cookie, now)
  const ended = s == null && viewToken(config, cookie) != null
  if (ended) s = await readSession(config, db, cookie, now, { own: true })
  const reviews = s != null && (await db.listDependencyReviewTeams(s.user.id)).length > 0
  return {
    body: s && {
      user: { id: s.user.id, login: s.user.login, name: s.user.name, role: s.user.role },
      csrfToken: s.session.csrfToken,
      ...(s.session.viewer ? { viewer: s.session.viewer } : {}),
      ...(reviews ? { dependencyReview: true as const } : {}),
    },
    headers: ended ? { 'set-cookie': clearViewCookie(config) } : {},
  }
}

// GET /api/admin/scan/models — the server's canonical scan model ids and effort
// levels. Names are intentionally absent; the client derives them from ids.
async function handleListModels(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readManageSession(res, deps, cookie, { handed: true })
  if (s == null) return
  sendJson(res, 200, { models: MANAGED_SCAN_MODELS, defaultModel: DEFAULT_MANAGED_SCAN_MODEL })
}

// GET /api/admin/repositories — the connected repositories by default. The
// potentially large GitHub discovery lists are opt-in (`scope=installed` or
// `scope=public`). Return the complete catalogue for local search and organization
// filtering. Admin-only. No CSRF.
async function handleListRepositories(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, discovery: RepositoryDiscovery): Promise<void> {
  if ((req.method ?? 'GET') !== 'GET') { send405(res, 'GET'); return }
  const s = await readAdminSession(res, deps, cookie, { handed: true })
  if (s == null) return
  const url = new URL(req.url ?? '/', 'http://localhost')
  // Keep the original unparameterized response shape for older clients. The
  // admin UI always sends an explicit scope, which opts into the connected-first
  // discovery flow below.
  if ([...url.searchParams.keys()].length === 0) {
    const token = await ensureUserAccessToken(deps.config, deps.db, s.user.id, Date.now())
    const listing = await collectRepos(deps.config, token)
    const selected = new Set((await deps.db.listSelectedRepos()).map((repo) => repo.repoId))
    sendJson(res, 200, {
      installUrl: installUrl(deps.config),
      repositories: listing.repositories.map((repo) => ({
        id: repo.id, fullName: repo.fullName, private: repo.private, visibility: repo.visibility, htmlUrl: repo.htmlUrl,
        installed: repo.installationId != null, selected: selected.has(repo.id),
      })),
      tokenMissing: listing.tokenMissing,
    })
    return
  }
  const scope = url.searchParams.get('scope') ?? 'connected'
  if (scope !== 'connected' && scope !== 'installed' && scope !== 'public') { sendJson(res, 400, { error: 'bad-scope' }); return }
  const selectedRows = await deps.db.listSelectedRepos()
  const allRows = scope === 'connected' ? await deps.db.listAllRepos() : []
  const selected = new Set(selectedRows.map((r) => r.repoId))
  let tokenMissing = false
  let repositories
  if (scope === 'connected') {
    const reviews = await deps.db.listRepoDependencyReviews()
    const reviewTeams = await deps.db.listRepoReviewTeams()
    repositories = allRows.map((r) => ({
      id: r.repoId, fullName: r.fullName, private: r.private, htmlUrl: r.htmlUrl,
      installed: r.installationId != null, selected: r.active, active: r.active,
      dependencyReview: reviews.get(r.repoId) ?? { enabled: false, required: 1, since: null, lockfiles: EVERY_LOCKFILE },
      reviewTeams: reviewTeams.get(r.repoId) ?? [],
    }))
  } else {
    const showAll = scope === 'installed' && url.searchParams.get('showAll') === 'true'
    const token = showAll ? null : await ensureUserAccessToken(deps.config, deps.db, s.user.id, Date.now())
    let listing
    try {
      listing = await discovery.list(scope, s.user.id, token, showAll, url.searchParams.get('refresh') === 'true')
    } catch (err) {
      if (!(err instanceof GithubApiError)) throw err
      sendJson(res, 502, { error: err.message })
      return
    }
    tokenMissing = listing.tokenMissing
    repositories = listing.repositories
      .map((r) => ({
        id: r.id, fullName: r.fullName, private: r.private, visibility: r.visibility, htmlUrl: r.htmlUrl,
        installed: r.installationId != null, selected: selected.has(r.id),
      }))
  }
  repositories.sort((a, b) => a.fullName.localeCompare(b.fullName))
  const total = repositories.length
  sendJson(res, 200, {
    installUrl: installUrl(deps.config),
    canAddAnyPublicRepository: canAddAnyPublicRepository(s.user, await deps.db.getUserGithubId(s.user.id)),
    repositories,
    connectedCount: selectedRows.length,
    inactiveCount: allRows.filter((r) => !r.active).length,
    total,
    tokenMissing,
    ...deps.reviewedDependencies ? { reviewedDependencies: true } : {},
  })
}

// The select half of the toggle: re-list the caller's reachable repos to VERIFY
// access (never trust a client-supplied id) and capture the server-derived read
// context (installation id, default branch). A PRIVATE repo with no installation
// can't be read server-side → 409. Stores via selectRepo (upsert).
async function selectRepository(res: ServerResponse, deps: ManagedHttpDeps, user: StoredUser, repoId: number, cookie: string | undefined): Promise<void> {
  if (!canAddRepositories(user)) { sendJson(res, 403, { error: 'forbidden' }); return }
  const userId = user.id
  const token = await ensureUserAccessToken(deps.config, deps.db, userId, Date.now())
  const { repositories } = await collectRepos(deps.config, token)
  let repo = repositories.find((r) => r.id === repoId)
  // A WHITEHAT addition may not appear in /user/repos. Revalidate the stored
  // canonical name when reactivating it, with the same permission gates.
  if (repo == null && canAddAnyPublicRepository(user, await deps.db.getUserGithubId(userId))) {
    const stored = (await deps.db.listAllRepos()).find(r => r.repoId === repoId)
    if (stored && !stored.private && stored.installationId == null) {
      try { repo = await fetchPublicRepository(stored.fullName) } catch (err) {
        if (!(err instanceof GithubApiError)) throw err
        sendJson(res, err.status, { error: err.message }); return
      }
      if (repo.id !== repoId) { sendJson(res, 409, { error: 'repo-identity-changed' }); return }
    }
  }
  if (repo == null) { sendJson(res, 404, { error: 'repo-not-accessible' }); return }
  // (0) Installed or explicitly public. For (3a), an admin may choose any App
  // installation; for (3b), /user/repos is the public involvement evidence.
  if (repo.installationId == null) {
    if (repo.private || repo.visibility !== 'public') { sendJson(res, 409, { error: 'repo-not-readable' }); return }
    if (!passesPublicRepositorySafeguard(await deps.db.getUserGithubId(userId), repositories.some(r => r.id === repoId))) {
      sendJson(res, 403, { error: 'forbidden' }); return
    }
  }
  if (await readAdminSession(res, deps, cookie) == null) return
  await connectRepository(res, deps, user, repo)
}

async function connectRepository(res: ServerResponse, deps: ManagedHttpDeps, user: StoredUser, repo: ConnectedRepo): Promise<void> {
  const alreadySelected = (await deps.db.listSelectedRepos()).some(row => row.repoId === repo.id)
  await deps.db.selectRepo({
    repoId: repo.id, fullName: repo.fullName, private: repo.private,
    installationId: repo.installationId, defaultBranch: repo.defaultBranch,
    htmlUrl: repo.htmlUrl, addedBy: user.id,
  }, Date.now())
  if (!alreadySelected) await activity(deps, user, 'repository', 'connected a repository', { repo: repo.fullName })
  sendJson(res, 200, { ok: true, selected: true })
}

// Separate from ordinary discovery: WHITEHAT bypasses only public involvement.
// Authentication, server admin permission, origin and CSRF remain mandatory.
async function handleAddPublicRepository(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') { send405(res, 'POST'); return }
  const s = await adminMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  if (!canAddAnyPublicRepository(s.user, await deps.db.getUserGithubId(s.user.id))) { sendJson(res, 403, { error: 'forbidden' }); return }
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const fullName = publicRepositoryName((body as { repository?: unknown } | null)?.repository)
  if (fullName == null) { sendJson(res, 400, { error: 'bad-repository' }); return }
  let repo
  try { repo = await fetchPublicRepository(fullName) } catch (err) {
    if (!(err instanceof GithubApiError)) throw err
    sendJson(res, err.status, { error: err.message }); return
  }
  // A GitHub lookup can outlive a role change or logout.
  if (await readAdminSession(res, deps, cookie) == null) return
  // Only public access was verified. Keep its null installation context rather
  // than restoring a stored App installation that may no longer cover this repo.
  await connectRepository(res, deps, s.user, repo)
}

// Associate an existing connection with this App without changing its active
// state, ownership, team grants, or stored data. GitHub grants remain separate
// from the per-user checks required for browsing source.
async function handleConnectRepositoryApp(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') { send405(res, 'POST'); return }
  const s = await adminMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const repoId = (body as { repoId?: unknown } | null)?.repoId
  if (typeof repoId !== 'number' || !Number.isSafeInteger(repoId) || repoId <= 0) { sendJson(res, 400, { error: 'bad-request' }); return }
  const repo = (await deps.db.listAllRepos()).find(row => row.repoId === repoId)
  if (repo == null) { sendJson(res, 404, { error: 'repo-not-connected' }); return }
  if (repo.installationId != null) { sendJson(res, 200, { connected: true }); return }
  let installationId
  try { installationId = await repositoryInstallation(deps.config, repo.repoId, repo.fullName) } catch (err) {
    if (!(err instanceof GithubApiError)) throw err
    // These credentials belong to the server App, not the user's session.
    sendJson(res, err.status === 401 ? 502 : err.status, { error: err.message }); return
  }
  if (await readAdminSession(res, deps, cookie) == null) return
  if (installationId == null) {
    const current = (await deps.db.listAllRepos()).find(row => row.repoId === repoId)
    if (current == null || current.fullName !== repo.fullName || current.addedAt !== repo.addedAt || current.installationId != null) {
      sendJson(res, 409, { error: 'repo-connection-changed' }); return
    }
    const url = installUrl(deps.config)
    if (url == null) { sendJson(res, 503, { error: 'github-app-not-configured' }); return }
    sendJson(res, 200, { connected: false, installUrl: url }); return
  }
  if (!await deps.db.connectRepoInstallation(repo, installationId, s.session.id, Date.now())) {
    sendJson(res, 409, { error: 'repo-connection-changed' }); return
  }
  await activity(deps, s.user, 'repository', 'connected GitHub App access', { repo: repo.fullName })
  sendJson(res, 200, { connected: true })
}

// POST /api/admin/repositories/select — an admin toggles whether a repo is
// active in the operate-on set. Mutation: same-origin + CSRF. Body { repoId,
// selected }. selected:true verifies + records the read context; selected:false
// deactivates the row while retaining its reports, bundles, and metadata.
async function handleSelectRepository(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') { send405(res, 'POST'); return }
  const s = await adminMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const repoId = (body as { repoId?: unknown } | null)?.repoId
  const selected = (body as { selected?: unknown } | null)?.selected
  if (typeof repoId !== 'number' || !Number.isSafeInteger(repoId) || typeof selected !== 'boolean') {
    sendJson(res, 400, { error: 'bad-request' }); return
  }
  if (!selected) {
    const repo = (await deps.db.listSelectedRepos()).find(row => row.repoId === repoId)
    if (await readAdminSession(res, deps, cookie) == null) return
    await deps.db.deactivateRepo(repoId)
    if (repo) await activity(deps, s.user, 'repository', 'deactivated a repository', { repo: repo.fullName })
    sendJson(res, 200, { ok: true, selected: false }); return
  }
  await selectRepository(res, deps, s.user, repoId, cookie)
}

// POST /api/admin/repositories/dependency-review — a repository's dependency
// review (repository-dependency-reviews.ts): `enabled`, the published reviews
// each version its pull requests' lockfiles lock needs (`required`, 1 to
// MAX_REQUIRED_REVIEWS), and the commit whose lockfiles' versions need none
// (`since`, a full commit id, or null; where the host registered reviewed
// dependencies, which replace it, none, `400 since-unsupported`, the one
// stored kept as it is). Answers the setting then. Admin, CSRF.
async function handleRepositoryDependencyReview(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') { send405(res, 'POST'); return }
  const s = await adminMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: Record<string, unknown> | null
  try { body = await readJsonBody(req) as Record<string, unknown> | null } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const repoId = body?.['repoId']
  const enabled = body?.['enabled']
  const required = body?.['required']
  const since = body?.['since'] ?? null
  // The lockfiles it holds to, kept as they are where none is sent.
  const lockfiles = body?.['lockfiles'] === undefined ? undefined : scopeOf(body['lockfiles'])
  if (typeof repoId !== 'number' || !Number.isSafeInteger(repoId) || typeof enabled !== 'boolean'
    || typeof required !== 'number' || !Number.isSafeInteger(required) || required < 1 || required > MAX_REQUIRED_REVIEWS
    || (since !== null && (typeof since !== 'string' || !SINCE_COMMIT.test(since))) || lockfiles === null) {
    sendJson(res, 400, { error: 'bad-request' }); return
  }
  if (since !== null && deps.reviewedDependencies) { sendJson(res, 400, { error: 'since-unsupported' }); return }
  const repo = (await deps.db.listAllRepos()).find(row => row.repoId === repoId)
  const setting = repo ? await deps.db.setRepoDependencyReview(repoId, { enabled, required, ...deps.reviewedDependencies ? {} : { since: since as string | null },
    ...lockfiles ? { lockfiles } : {} }) : null
  if (!repo || !setting) { sendJson(res, 404, { error: 'no-repository' }); return }
  await activity(deps, s.user, 'repository', enabled ? 'enabled dependency review' : 'disabled dependency review', { repo: repo.fullName })
  sendJson(res, 200, { ok: true, dependencyReview: setting })
}

async function repositoryFindingIds(deps: ManagedHttpDeps, reports: { id: string, filename: string }[]): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const report of reports) {
    const bytes = await deps.reportStore.get(report.id)
    if (bytes == null) throw new Error(`Cannot establish repository triage overlap: report ${report.id} is unavailable`)
    const parsed = await loadManagedFindings(bytes.toString('utf8'), report.filename)
    if (parsed == null) throw new Error(`Cannot establish repository triage overlap: report ${report.id} is unreadable`)
    for (const finding of parsed.findings) {
      const id = (finding as { id?: unknown })?.id
      if (typeof id === 'string' && id !== '') ids.add(id)
    }
  }
  return ids
}

async function repositoryImpact(deps: ManagedHttpDeps, repoId: number) {
  const allReports = await deps.db.listReports()
  const reports = allReports.filter((report) => report.repoId === repoId)
  const bundles = await deps.db.listBundlesForRepo(repoId)
  const triageIds = await repositoryExclusiveTriageIds(deps, reports, allReports.filter((report) => report.repoId !== repoId))
  return {
    reports: reports.map((report) => ({ id: report.id, filename: report.filename, repoDirectory: report.repoDirectory })),
    bundles,
    triageCount: triageIds.length,
  }
}

async function repositoryExclusiveTriageIds(deps: ManagedHttpDeps, reports: { id: string, filename: string }[], otherReports: { id: string, filename: string }[], annotationsOnly = true): Promise<string[]> {
  const targetIds = await repositoryFindingIds(deps, reports)
  const triage = annotationsOnly ? await deps.db.listTriage([...targetIds]) : []
  const commentIds = annotationsOnly ? await deps.db.listCommentedFindingIds([...targetIds]) : []
  // Removal includes every exclusive finding, including annotations created
  // during the blob scan; impact only needs the currently annotated subset.
  const annotatedIds = annotationsOnly ? new Set([...triage.map(entry => entry.findingId), ...commentIds]) : targetIds
  if (annotatedIds.size === 0) return []
  // Impact can skip unannotated findings; deletion must also cover new writes.
  // TODO(managed): Persist finding IDs per report at upload time and maintain
  // the index on report deletion. Use it for repository impact and triage
  // cleanup so overlap checks do not fetch and parse every other report blob.
  // Deferred for production; the preview still performs the blob scan below.
  const otherIds = await repositoryFindingIds(deps, otherReports)
  return [...annotatedIds].filter((id) => !otherIds.has(id))
}

// GET /api/admin/repositories/impact — show the data a permanent repository
// removal would destroy. This is intentionally separate from the repository
// list so the normal page stays cheap even with many reports.
async function handleRepositoryImpact(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readAdminSession(res, deps, cookie, { handed: true })
  if (s == null) return
  const repoId = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('repoId'))
  if (!Number.isSafeInteger(repoId)) { sendJson(res, 400, { error: 'bad-repo' }); return }
  const repo = (await deps.db.listAllRepos()).find((candidate) => candidate.repoId === repoId)
  if (repo == null) { sendJson(res, 404, { error: 'no-repo' }); return }
  sendJson(res, 200, { repoId, fullName: repo.fullName, ...await repositoryImpact(deps, repoId) })
}

// POST /api/admin/repositories/remove — permanently remove a repository and
// attached reports/bundles. The exact name + explicit acknowledgement are
// checked server-side too; the UI's dialog is a usability guard, not the policy.
async function handleRemoveRepository(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await checkMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  if (s.user.role !== 'admin') { sendJson(res, 403, { error: 'forbidden' }); return }
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const repoId = (body as { repoId?: unknown } | null)?.repoId
  const fullName = (body as { fullName?: unknown } | null)?.fullName
  const acknowledge = (body as { acknowledge?: unknown } | null)?.acknowledge
  const deleteTriage = (body as { deleteTriage?: unknown } | null)?.deleteTriage
  if (typeof repoId !== 'number' || !Number.isSafeInteger(repoId) || typeof fullName !== 'string' || acknowledge !== true || typeof deleteTriage !== 'boolean') {
    sendJson(res, 400, { error: 'confirmation-required' }); return
  }
  const repo = (await deps.db.listAllRepos()).find((candidate) => candidate.repoId === repoId)
  if (repo == null) { sendJson(res, 404, { error: 'no-repo' }); return }
  if (repo.fullName !== fullName) { sendJson(res, 400, { error: 'repo-name-mismatch' }); return }
  const allReports = deleteTriage ? await deps.db.listReports() : []
  const triageIds = deleteTriage
    ? await repositoryExclusiveTriageIds(deps, allReports.filter(report => report.repoId === repoId), allReports.filter(report => report.repoId !== repoId), false)
    : []
  const { reports, bundles, deletedReports, deletedBundles, deletedTriage } = await deps.db.removeRepository(s.session.id, repo,
    deleteTriage ? { reports: reportReferenceSnapshot(allReports), ids: triageIds } : null)
  // Remove metadata first so a blob-store failure leaves an orphaned blob for
  // later cleanup, rather than a live row pointing at missing report data.
  for (const report of reports) {
    await deps.reportSourcesCache?.deleteReport(report).catch((err) => { console.warn('managed: report sources delete failed:', err) })
    await deps.reportStore.delete(report.id).catch(() => {})
  }
  for (const bundle of bundles) {
    // Best-effort derivative cleanup follows the committed metadata removal.
    await deps.bundleCache?.delete(bundle.id).catch((err) => { console.warn('managed: bundle cache delete failed:', err) })
    await deps.reportSourcesCache?.deleteBundle(bundle.id).catch((err) => { console.warn('managed: report sources delete failed:', err) })
    await deps.bundleStore.delete(bundle.id).catch(() => {})
  }
  sendJson(res, 200, { ok: true, deletedReports, deletedBundles, deletedTriage })
}

// Strip a client-supplied upload filename to a safe display string. The bytes
// are keyed by a server uuid. This name is used for display, Content-Disposition,
// and format detection: decode URLs, remove controls/paths, and cap the basename
// without discarding the extension that the report reader needs.
// Falls back to `fallback` when nothing usable remains.
function sanitizeFilename(raw: string | null, fallback: string): string {
  if (raw == null || raw === '') return fallback
  let decoded = raw
  try { decoded = decodeURIComponent(raw) } catch { decoded = raw }
  // Build the cleaned name char-by-char: drop control chars, fold path
  // separators to '_' (avoids a control-character regex).
  let cleaned = ''
  for (const ch of decoded) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) continue
    cleaned += ch === '/' || ch === '\\' ? '_' : ch
  }
  cleaned = cleaned.trim()
  if (cleaned.length <= 200) return cleaned || fallback
  const dot = cleaned.lastIndexOf('.')
  const suffix = dot > 0 ? cleaned.slice(dot) : ''
  // An extension that alone exceeds the cap cannot fit; ordinary extensions
  // (including case-sensitive display names such as .CSV) remain unchanged.
  const extension = suffix.length < 200 ? suffix : ''
  return cleaned.slice(0, 200 - extension.length) + extension
}

// The selected repos a report / bundle can be linked to, for the upload UI's
// repo picker. Minimal shape (id + full name).
function selectableRepos(repos: { repoId: number; fullName: string }[]): { repoId: number; fullName: string }[] {
  return repos.map((r) => ({ repoId: r.repoId, fullName: r.fullName }))
}

// Resolve the optional X-Repo-Id upload header to a selected repo id, or null
// when absent. Validates the id is currently in the selected-repos set (so the
// FK can't dangle); on a bad / unknown id sends 400 and returns { ok: false }.
async function resolveUploadRepoId(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps): Promise<{ ok: true; repoId: number | null } | { ok: false }> {
  const raw = firstHeader(req.headers['x-repo-id'])
  if (raw == null || raw === '') return { ok: true, repoId: null }
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) { sendJson(res, 400, { error: 'bad-repo' }); return { ok: false } }
  const selected = await deps.db.listSelectedRepos()
  if (!selected.some((r) => r.repoId === n)) { sendJson(res, 400, { error: 'repo-not-selected' }); return { ok: false } }
  return { ok: true, repoId: n }
}

// POST /api/admin/reports/set-repo — attach / detach a stored report's repo
// + directory link. Mutation: same-origin + CSRF, admin|manage. Body
// { reportId, repoId, directory }, where repoId is null (detach) or a
// currently-selected repo id. Directory is relative to the repository root.
async function handleSetReportRepo(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const reportId = (body as { reportId?: unknown } | null)?.reportId
  const repoId = (body as { repoId?: unknown } | null)?.repoId ?? null
  const directory = (body as { directory?: unknown } | null)?.directory ?? ''
  if (typeof reportId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  if (repoId !== null && (typeof repoId !== 'number' || !Number.isSafeInteger(repoId))) { sendJson(res, 400, { error: 'bad-repo' }); return }
  const normalized = normalizeTeamPath(directory)
  if (!normalized.ok) { sendJson(res, 400, { error: 'bad-directory' }); return }
  const { report, user } = await deps.db.mutateReport(s.session.id, reportId, { type: 'repo', repoId, directory: normalized.path ?? '' })
  if (report.repoId !== repoId || report.repoDirectory !== (repoId == null ? '' : normalized.path ?? '')) {
    await activity(deps, user, 'repository', repoId == null ? 'detached a report from its repository' : `assigned a report to repository path ${normalized.path || '/'}`, { reportId, report: report.filename, repo: await repositoryName(deps, repoId ?? report.repoId) })
  }
  sendJson(res, 200, { ok: true, repoId, repoDirectory: normalized.path ?? '' })
}

// POST /api/admin/reports/set-visible — publish or hide a stored report. New
// reports start hidden so an admin can inspect the parsed metadata first.
async function handleSetReportVisible(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const reportId = (body as { reportId?: unknown } | null)?.reportId
  const visible = (body as { visible?: unknown } | null)?.visible
  if (typeof reportId !== 'string' || typeof visible !== 'boolean') { sendJson(res, 400, { error: 'bad-request' }); return }
  const { report, user } = await deps.db.mutateReport(s.session.id, reportId, { type: 'visibility', visible })
  if (report.visible !== visible) await activity(deps, user, 'visibility', visible ? 'published a report' : 'hid a report', { reportId, report: report.filename, repo: await repositoryName(deps, report.repoId) })
  sendJson(res, 200, { ok: true, visible })
}

async function handleSetBundleVisible(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const bundleId = (body as { bundleId?: unknown } | null)?.bundleId
  const visible = (body as { visible?: unknown } | null)?.visible
  if (typeof bundleId !== 'string' || typeof visible !== 'boolean') { sendJson(res, 400, { error: 'bad-request' }); return }
  const { bundle, user } = await deps.db.mutateBundle(s.session.id, bundleId, { type: 'visibility', visible })
  if (bundle.visible !== visible) await activity(deps, user, 'visibility', visible ? 'published a bundle' : 'hid a bundle', { bundleId, report: bundle.filename, repo: await repositoryName(deps, bundle.repoId) })
  sendJson(res, 200, { ok: true, visible })
}

// POST /api/admin/bundles/set-repo — attach / detach a stored bundle's repo link
// and directory (same shape as reports). Body { bundleId, repoId, directory }.
async function handleSetBundleRepo(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const bundleId = (body as { bundleId?: unknown } | null)?.bundleId
  const repoId = (body as { repoId?: unknown } | null)?.repoId ?? null
  const normalized = normalizeTeamPath((body as { directory?: unknown } | null)?.directory ?? '')
  if (!normalized.ok) { sendJson(res, 400, { error: 'bad-directory' }); return }
  const directory = repoId == null ? '' : normalized.path ?? ''
  if (typeof bundleId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  if (repoId !== null && (typeof repoId !== 'number' || !Number.isSafeInteger(repoId))) { sendJson(res, 400, { error: 'bad-repo' }); return }
  const { bundle, user } = await deps.db.mutateBundle(s.session.id, bundleId, { type: 'repo', repoId, directory })
  if (bundle.repoId !== repoId || bundle.repoDirectory !== directory) await activity(deps, user, 'repository', repoId == null ? 'detached a bundle from its repository' : `assigned a bundle to repository path ${directory || '/'}`, { bundleId, report: bundle.filename, repo: await repositoryName(deps, repoId ?? bundle.repoId) })
  sendJson(res, 200, { ok: true, repoId, repoDirectory: directory })
}

// GET /api/admin/reports — the uploaded reports for the "Manage reports" page.
// Visible to admin|manage. Read-only, so no CSRF (like /api/admin/users).
// `maxBytes` lets the page show / pre-check the upload size cap; `repos` feeds
// the upload repo picker.
async function handleListReports(res: ServerResponse, deps: ManagedHttpDeps, session: ManagedSession): Promise<void> {
  sendJson(res, 200, {
    ...await deps.db.getReportCatalog(session.id, Date.now()),
    maxBytes: deps.config.maxReportBytes,
  })
}

// Resolve a report's bundle link from its embedded `bundleHashes`: the first
// declared integrity that has a stored bundle wins (bundleId set). When none is
// stored yet, keep the first declared integrity so a later bundle upload of it
// re-links (see linkReportsToBundle). Returns the (bundleId, integrity) to store.
async function resolveReportBundle(deps: ManagedHttpDeps, user: StoredUser, json: unknown): Promise<{ bundleId: string | null; integrity: string | null }> {
  const hashes = reportBundleHashes(json)
  for (const h of hashes) {
    const b = await deps.db.getBundleByIntegrity(h)
    if (b != null && await canAccessBundle(deps, user, b.id)) return { bundleId: b.id, integrity: h }
  }
  return { bundleId: null, integrity: hashes[0] ?? null }
}

async function sendUploadedReport(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, report: ReportRecord, deduped: boolean): Promise<void> {
  const current = await checkMutation(req, res, deps, cookie)
  if (!current || !requireManageRole(res, current.user)) return
  // Uploading known bytes cannot reveal another team's report or its source
  // bundle. The stored location/ownership wins over the upload headers.
  if (!(await canViewReport(deps, current.user, report.id))) { sendJson(res, 409, { error: 'report-conflict' }); return }
  const bundleId = report.bundleId != null && await canAccessBundle(deps, current.user, report.bundleId) ? report.bundleId : null
  const { id, slug, filename, byteSize, sha256, repoId, repoDirectory, repoEmbedded, analyzer, visible } = report
  sendJson(res, deduped ? 200 : 201, { id, slug, filename, byteSize, sha256, repoId, repoDirectory, repoEmbedded, analyzer, visible, bundleId, ...(deduped ? { deduped: true } : {}) })
}

// POST /api/admin/reports — upload a report. Mutation: same-origin + CSRF,
// admin|manage. The body is the raw report bytes (any findings format — JSON /
// markdown / CSV — archived as-is, like the e2e objstore; the server parses them
// downstream). Display name rides X-Report-Filename; the repository and
// directory come from the report header, or from optional repository/directory
// headers when the report has no repository metadata, else from the repository
// its findings name when that resolves within the uploader's access. The bundle link is
// auto-resolved from the report's bundleHashes. New reports start hidden until
// published. Identical content reuses its stored identity and metadata. Bytes
// are written first (keyed by a fresh uuid) then the metadata row. A definite
// insert failure or concurrent duplicate drops the orphan blob; an uncertain
// commit retains it. 413 over the cap, 400 on empty.
async function handleUploadReport(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  let s = await checkMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  if (!requireManageRole(res, s.user)) return
  let bytes: Buffer
  try {
    bytes = await readUploadBody(req, deps, s.session, 'reports')
  } catch (err) {
    const tooLarge = err instanceof Error && err.message === 'too-large'
    sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'too-large' : 'bad-body' })
    return
  }
  // Shared storage reads may outlast a session or role change.
  s = await checkMutation(req, res, deps, cookie)
  if (!s || !requireManageRole(res, s.user)) return
  if (bytes.length === 0) { sendJson(res, 400, { error: 'empty' }); return }
  const filename = sanitizeFilename(firstHeader(req.headers['x-report-filename']), 'report.json')
  const parsed = readManagedReport(bytes.toString('utf8'), filename)
  if (parsed.data == null) {
    sendJson(res, 400, { error: 'invalid-report', reason: parsed.reason ?? 'Unrecognized report format' })
    return
  }
  if (parsed.format === 'links' || parsed.data.source === 'links') {
    const result = await deps.db.importLinkReport(s.session.id, filename, bytes.toString('utf8'))
    sendJson(res, result.reused ? 200 : 201, { ...result.report, kind: 'links', deduped: result.reused })
    return
  }
  const repoGithub = reportRepoGithub(parsed.data)
  // The browser splits these documents before upload. Enforce that boundary
  // for direct API clients too: one stored record has only one repo's ACL.
  if (parsed.format === 'markdown-generic' && repoGithub == null) {
    sendJson(res, 400, { error: 'invalid-report', reason: 'Multi-product Markdown must be split into one report per product before upload.' })
    return
  }
  const repoEmbedded = repoGithub != null
  const rawHeaderDirectory = firstHeader(req.headers['x-repo-directory']) ?? ''
  let headerDirectory = rawHeaderDirectory
  try { headerDirectory = decodeURIComponent(rawHeaderDirectory) } catch { sendJson(res, 400, { error: 'bad-directory' }); return }
  // Validate the raw header, not repoDirectory()'s display/link normalization,
  // which trims characters and turns invalid paths into the repository root.
  const requestedDirectory = repoEmbedded ? parsed.data?.repo?.directory : headerDirectory
  const normalizedDirectory = normalizeTeamPath(requestedDirectory)
  if (!normalizedDirectory.ok) { sendJson(res, 400, { error: 'bad-directory' }); return }
  let directory = normalizedDirectory.path ?? ''
  const analyzer = typeof parsed.data.source === 'string' ? parsed.data.source : null
  const sha256 = createHash('sha256').update(bytes).digest('base64url')
  // Reuploads retain their stored location, including after an alias changes.
  const existing = await deps.db.getReportByHash(sha256, analyzer)
  let repoId: number | null = null
  if (repoGithub != null) {
    const location = existing ? { repoId: existing.repoId, directory: existing.repoDirectory }
      : await deps.db.getRepositoryImportLocation(repoGithub, directory)
    repoId = location.repoId; directory = location.directory
    if (!existing && repoId == null) { sendJson(res, 400, { error: 'repo-not-connected', repo: repoGithub }); return }
  }
  // When the report has no repository header, X-Repo-Id lets the managed uploader
  // assign it at upload time. Clients may omit it and attach the report later.
  if (repoGithub == null) {
    const legacyRepo = await resolveUploadRepoId(req, res, deps)
    if (!legacyRepo.ok) return
    repoId = legacyRepo.repoId
    // Otherwise the repository its findings name assigns a new report, like
    // embedded metadata, when it resolves to a connected destination within
    // the uploader's access. X-Repo-Directory still overrides the directory.
    if (repoId == null && !existing) {
      const suggestion = await suggestReportLocation(deps, s.user, parsed.data)
      if (suggestion?.repoId != null) {
        const inferred = req.headers['x-repo-directory'] == null ? suggestion.directory ?? '' : directory
        if (s.user.role === 'admin' || await deps.db.userCanReadRepoPath(s.user.id, suggestion.repoId, inferred)) {
          repoId = suggestion.repoId
          directory = inferred
        }
      }
    }
  }
  if (repoId != null && s.user.role !== 'admin' && !(await deps.db.userCanReadRepoPath(s.user.id, repoId, directory))) { sendJson(res, 403, { error: 'repo-forbidden' }); return }
  if (existing) { await sendUploadedReport(req, res, deps, cookie, existing, true); return }
  const id = randomUUID()
  const contentType = (firstHeader(req.headers['content-type']) ?? '').split(';', 1)[0]!.trim() || 'application/json'
  // A JSON report's parse already in hand, not parsed again for its hashes.
  const { bundleId, integrity } = await resolveReportBundle(deps, s.user, parsed.format === 'json' ? parsed.data : null)
  const dataKey = await deps.reportStore.put(id, bytes)
  let report: ReportRecord
  try {
    report = await deps.db.insertOrReuseReport({
      id, filename, contentType, byteSize: bytes.length, sha256, dataKey,
      uploadedBy: s.user.id, uploadedByLogin: s.user.login, repoId,
      repoDirectory: directory, repoEmbedded, analyzer, visible: false, bundleId, bundleIntegrity: integrity,
    }, Date.now(), s.session.id)
  } catch (err) {
    // A successful COMMIT can lose its acknowledgement. Never delete a file
    // until a writer-locked read confirms that this candidate did not commit.
    let committed: ReportRecord | null
    try { committed = await deps.db.resolveReportUpload(id) }
    catch (lookup) { throw new AggregateError([err, lookup], 'Report upload reconciliation failed', { cause: lookup }) }
    if (committed) report = committed
    else { await deps.reportStore.delete(id).catch(() => {}); throw err }
  }
  if (report.id !== id) await deps.reportStore.delete(id).catch(() => {})
  await sendUploadedReport(req, res, deps, cookie, report, report.id !== id)
}

// GET /api/admin/reports/<id> — download a stored report (admin|manage). Serves
// the bytes with the recorded content-type + filename. The recorded content-type
// is uploader-supplied, so the response is forced to download
// (Content-Disposition: attachment) AND marked `nosniff` — it can't be sniffed
// or rendered inline against the app origin. 404 when there's no such report;
// 503 when the row exists but the bytes don't (store desync).
async function handleGetReport(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await readManageSession(res, deps, cookie, { handed: true })
  if (s == null) return
  if (!(await canViewReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  const rec = await deps.db.getReport(id)
  if (rec == null) { sendJson(res, 404, { error: 'no-report' }); return }
  const bytes = await deps.reportStore.get(id)
  if (bytes == null) { sendJson(res, 503, { error: 'unavailable' }); return }
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!current || !roleAtLeast(current.user.role, 'manage') || !(await canViewReport(deps, current.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  res.writeHead(200, {
    'content-type': rec.contentType,
    'content-length': String(bytes.length),
    'content-disposition': attachmentDisposition(rec.filename),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  })
  writeResponse(res, bytes)
}

// DELETE /api/admin/reports/<id> — remove a report (admin|manage). Mutation:
// same-origin + CSRF. Drops the row, then best-effort the bytes; 404 when there
// was no such report.
async function handleDeleteReport(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await checkMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  if (!requireManageRole(res, s.user)) return
  const { report, user } = await deps.db.mutateReport(s.session.id, id, { type: 'delete' })
  await deps.reportSourcesCache?.deleteReport(report).catch((err) => { console.warn('managed: report sources delete failed:', err) })
  await deps.reportStore.delete(id).catch((err) => { console.warn('managed: report bytes delete failed:', err) })
  await activity(deps, user, 'delete', 'deleted a report', { repoId: report.repoId, repoDirectory: report.repoDirectory, reportId: id, report: report.filename, repo: await repositoryName(deps, report.repoId) })
  sendJson(res, 200, { ok: true })
}

// Apply the same access rule to inventory, cached derivatives, raw downloads
// and mutations. Ownership is a manager exception; lower roles require teams.
async function canAccessBundle(deps: ManagedHttpDeps, user: StoredUser, id: string): Promise<boolean> {
  if (!roleAtLeast(user.role, 'view')) return false
  const rec = await deps.db.getBundle(id)
  if (!rec) return false
  if (user.role === 'admin') return true
  if (user.role === 'manage') return deps.db.userCanReadBundle(user.id, id)
  return rec.visible && rec.repoId !== null && deps.db.userCanReadRepoPath(user.id, rec.repoId, rec.repoDirectory)
}

async function bundleRepos(deps: ManagedHttpDeps, user: StoredUser) {
  const repos = await deps.db.listSelectedRepos()
  const access = await contentAccess(deps.db, user)
  return repos.filter(access.bundle)
}

async function repositoryBrowserUser(deps: ManagedHttpDeps, userId: string) {
  const [githubUserId, token] = await Promise.all([
    deps.db.getUserGithubId(userId), ensureUserAccessToken(deps.config, deps.db, userId, Date.now()),
  ])
  return { githubUserId, token }
}

// After a catalog response: read the commit details it lacked with this
// user's repository access, for the next catalog to send.
async function backfillCatalogCommits(deps: ManagedHttpDeps, userId: string, missing: readonly CatalogCommit[]): Promise<void> {
  let browser: ReturnType<typeof createRepositoryBrowser> | undefined
  let repos: ReturnType<ManagedDb['listAllRepos']> | undefined
  await backfillBundleCommits(deps.db, userId, missing, async repoId => {
    // Read once for the repositories the backfill reaches, not once each.
    const repo = (await (repos ??= deps.db.listAllRepos())).find(item => item.repoId === repoId)
    if (!repo) return null
    browser ??= createRepositoryBrowser(deps.config, await repositoryBrowserUser(deps, userId))
    return browser.reader(repo)
  }).catch(err => { console.warn('managed: commit backfill failed:', err) })
}

// Listing connected repository names uses managed access only. Verify GitHub
// access after selection, before returning any refs or source directory data.
// Any team member (view or above) lists those their teams reach, for the code
// viewer as for Create a bundle, whose builds stay admin|manage.
async function handleBrowsableRepositories(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readWorkspaceSession(res, deps, cookie, { handed: true })
  if (!s) return
  sendJson(res, 200, { repos: selectableRepos(await bundleRepos(deps, s.user)) })
}

type RepositoryReader = Awaited<ReturnType<ReturnType<typeof createRepositoryBrowser>['reader']>>
type RepositoryContents = Awaited<ReturnType<typeof readRepositoryContents>>
type RepositoryRefs = Awaited<ReturnType<RepositoryReader['refs']>> & { defaultContents?: RepositoryContents | null }

async function readRepositoryContents(reader: RepositoryReader, ref: string, path: string, virtualEntries: RepositoryEntry[] | null) {
  const commit = await reader.commit(ref)
  const contents = virtualEntries ? { entries: virtualEntries, limited: false } : await reader.directory(path, commit)
  return { ...contents, path, commit }
}

async function readRepositoryRefs(db: ManagedDb, reader: RepositoryReader, repo: SelectedRepo, withDefault: boolean, virtualEntries: RepositoryEntry[] | null): Promise<RepositoryRefs> {
  // Wait for both, including failures: a deleted cached branch must not prevent
  // a successful live default lookup from recovering the initial directory.
  const [refs, contents] = await Promise.allSettled([
    reader.refs(),
    withDefault && repo.cachedDefaultBranch ? readRepositoryContents(reader, `heads/${repo.cachedDefaultBranch}`, '', virtualEntries) : Promise.resolve(null),
  ])
  if (refs.status === 'rejected') throw refs.reason
  const defaultBranch = refs.value.defaultBranch || null
  const changed = defaultBranch !== repo.cachedDefaultBranch
  if (changed) await db.cacheRepoDefaultBranch(repo, defaultBranch)
  if (!withDefault) return refs.value
  if (!defaultBranch) return { ...refs.value, defaultContents: null }
  if (changed) return { ...refs.value, defaultContents: await readRepositoryContents(reader, `heads/${defaultBranch}`, '', virtualEntries) }
  if (contents.status === 'rejected') throw contents.reason
  return { ...refs.value, defaultContents: contents.value }
}

function scopeRepositoryContents(contents: RepositoryContents | null, virtualEntries: RepositoryEntry[] | null) {
  return contents && { ...contents, ...(virtualEntries ? {
    entries: virtualEntries, limited: false, packageEntryPoints: [], solidityEntryPoints: [], soliditySuggestionsLimited: false,
  } : {}) }
}

// A browse's repository, revision and directory, as its query names them;
// null, answered, where it names none.
function repositoryQuery(res: ServerResponse, query: URLSearchParams) {
  const repoId = Number(query.get('repoId'))
  const normalized = normalizeTeamPath(query.get('path') ?? '')
  const ref = query.get('ref') ?? ''
  if (!Number.isSafeInteger(repoId) || repoId <= 0 || !normalized.ok || ref.length > 1024 || /\p{Cc}/u.test(ref)) {
    sendJson(res, 400, { error: 'bad-request' }); return null
  }
  return { repoId, ref, path: normalized.path ?? '' }
}

// The repository `repoId` as the reader may browse it at `path`: one of their
// bundle repositories, and what their grants show of that directory
// (`virtualEntries`, null where they reach all of it: scopedDirectory). Null,
// answered, where it is none of theirs. Every team member (view or above)
// reads the repositories their teams reach; the reader then checks their own
// GitHub read permission (repository-browser.ts), on each read.
async function authorizeRepository(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, repoId: number, path: string, { handed = false } = {}) {
  const s = await readWorkspaceSession(res, deps, cookie, { handed })
  if (!s) return null
  const access = repositoryAccessIn(await repositoryGrants(deps, s.user), repoId, path)
  if (!access) { sendJson(res, 404, { error: 'no-repository' }); return null }
  return { ...access, user: s.user }
}

// What a reader's grants let them read of the repositories (bundleRepos's
// reads, the reader's scopes read once for both), for repositoryAccessIn to
// tell of each: read once for as many repositories as a request asks of.
async function repositoryGrants(deps: ManagedHttpDeps, user: StoredUser) {
  const access = await contentAccess(deps.db, user)
  return { access, repos: (await deps.db.listSelectedRepos()).filter(access.bundle) }
}
// Repository `repoId` as `grants` let it be read at `path`, as
// authorizeRepository answers it; null where it is none of the reader's.
function repositoryAccessIn({ access, repos }: Awaited<ReturnType<typeof repositoryGrants>>, repoId: number, path: string) {
  const repo = repos.find(item => item.repoId === repoId)
  if (!repo) return null
  const scopes = access.scopes == null ? [null] : access.scopes.filter(scope => scope.repoId === repoId).map(scope => scope.path)
  return { repo, virtualEntries: scopedDirectory(path, scopes) }
}

// The repository as it was authorized, but for the shared default branch hint,
// which a read may refresh meanwhile: that changes none of its identity,
// credentials or managed grants.
const sameRepository = (current: SelectedRepo, authorized: SelectedRepo) =>
  JSON.stringify({ ...current, cachedDefaultBranch: authorized.cachedDefaultBranch }) === JSON.stringify(authorized)

function sendGithubError(res: ServerResponse, err: GithubApiError) {
  sendJson(res, err.status === 401 ? 502 : err.status, { error: err.message }, err.retryAfter == null ? {} : { 'retry-after': String(err.retryAfter) })
}

// Recheck repository/path grants after upstream reads, before returning names.
async function handleRepositoryBrowser(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams, refs: boolean): Promise<void> {
  const asked = repositoryQuery(res, query)
  if (!asked) return
  const { repoId, ref } = asked
  const withDefault = refs && query.get('withDefault') === 'true'
  const path = refs ? '' : asked.path
  const authorize = async (handed = false) => {
    const access = await authorizeRepository(res, deps, cookie, repoId, path, { handed })
    if (access && (!refs || withDefault) && access.virtualEntries?.length === 0) { sendJson(res, 404, { error: 'no-directory' }); return null }
    return access
  }
  const access = await authorize(true)
  if (!access) return
  try {
    const browser = createRepositoryBrowser(deps.config, await repositoryBrowserUser(deps, access.user.id))
    const reader = await browser.reader(access.repo)
    // Microseconds, so overlapping browses practically never share a listing time.
    const observedUs = Math.round((performance.timeOrigin + performance.now()) * 1000)
    const revisions = refs ? await readRepositoryRefs(deps.db, reader, access.repo, withDefault, access.virtualEntries) : null
    const contents = refs ? null : await readRepositoryContents(reader, ref, path, access.virtualEntries)
    const { tagCommits, tagsComplete, ...listed } = revisions ?? { tagCommits: [], tagsComplete: false }
    // Every refs read (Create a bundle's, and the code viewer's) refreshes the
    // tags bundle catalogs show, and a tag read keeps the one its revision
    // input resolves even when the listed page leaves it out.
    // Like other GitHub caches, written before the access fence below.
    const tags = refs ? tagCommits : ref.length > 5 && ref.startsWith('tags/') && contents ? [{ name: ref.slice(5), sha: contents.commit }] : []
    if (refs || tags.length > 0) {
      await deps.db.refreshGithubTags(access.repo.repoId, tags, refs && tagsComplete, observedUs).catch(err => { console.warn('managed: tag cache refresh failed:', err) })
    }
    await reader.recheckAccess()
    const current = await authorize()
    if (!current) return
    // This request (or another reader) may have refreshed the shared hint.
    if (!sameRepository(current.repo, access.repo)) { sendJson(res, 409, { error: 'repository-changed' }); return }
    sendJson(res, 200, refs ? { ...listed, tagCommits, ...(withDefault ? {
      defaultContents: scopeRepositoryContents(revisions?.defaultContents ?? null, current.virtualEntries),
    } : {}) } : scopeRepositoryContents(contents, current.virtualEntries))
  } catch (err) {
    if (err instanceof GithubApiError) { sendGithubError(res, err); return }
    throw err
  }
}

// GET /api/admin/repositories/code: the files of a directory of a repository
// at a revision, for the code viewer (repository-code.ts), read as browsing
// it is, with the reader's own GitHub access, and only where their grants
// reach the whole directory: one they reach only the ancestor of is none to
// read. Its tree's listing says first whether its files fit, before its
// tarball is asked for; the reader's access is checked again once it is
// read, before any of it is sent. The load stays held until this response is
// written or abandoned, and a reader who stops reading it gives it up after
// a while.
// What GitHub answered of a repository's trees for the code viewer, which a
// commit or tree it names never changes: the tree at a directory of a commit
// (getRepoTreeId reads the commit, then a listing a level down to it), and
// how many files a tree holds under it and their bytes (repositoryTreeFiles),
// by the repository's id, for the next to open it. Asked of them only once
// the reader's own access has named the commit, as GitHub would have
// answered them; by the database, as each instance has one.
const REPOSITORY_TREES_KEPT = 4096
type TreeFiles = Awaited<ReturnType<typeof repositoryTreeFiles>>
const repositoryTrees = new WeakMap<ManagedDb, { ids: Lru<string>; files: Lru<TreeFiles> }>()
function repositoryTreesOf(db: ManagedDb) {
  let kept = repositoryTrees.get(db)
  if (!kept) repositoryTrees.set(db, kept = { ids: lru(REPOSITORY_TREES_KEPT), files: lru(REPOSITORY_TREES_KEPT) })
  return kept
}

async function handleRepositoryCode(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams): Promise<void> {
  const asked = repositoryQuery(res, query)
  if (!asked) return
  const { repoId, ref, path } = asked
  const authorize = async (handed = false) => {
    const access = await authorizeRepository(res, deps, cookie, repoId, path, { handed })
    if (access && access.virtualEntries !== null) { sendJson(res, 404, { error: 'no-directory' }); return null }
    return access
  }
  const access = await authorize(true)
  if (!access) return
  try {
    const reader = await createRepositoryBrowser(deps.config, await repositoryBrowserUser(deps, access.user.id)).reader(access.repo)
    const commit = await reader.commit(ref)
    const repo = access.repo.fullName
    const client = createClient({ token: reader.readToken() })
    const treeKey = `${access.repo.repoId}\0${commit}\0${path}`, trees = repositoryTreesOf(deps.db)
    // A directory the commit has none at is none to read, as browsing it says.
    const tree = trees.ids.get(treeKey) ?? await upstreamGithub(() => client.getRepoTreeId({ repo, sha: commit, ...(path ? { directory: path } : {}) }).catch((err: unknown) => {
      throw err instanceof Error && err.name === 'AssertionError' && err.message.includes(' has no directory at ') ? new GithubApiError(404, 'no-directory') : err
    }))
    trees.ids.set(treeKey, tree)
    // Access still held, and the same repository, before anything read is sent.
    const fenced = async () => {
      await reader.recheckAccess()
      const current = await authorize()
      if (!current) return false
      if (!sameRepository(current.repo, access.repo)) { sendJson(res, 409, { error: 'repository-changed' }); return false }
      return true
    }
    // Too large names the commit it was read at, for History to read.
    const filesKey = `${access.repo.repoId}\0${tree}`
    let listed = trees.files.get(filesKey)
    if (listed === undefined) trees.files.set(filesKey, listed = await repositoryTreeFiles(repo, reader.readToken(), tree))
    if (!repositoryCodeFits(listed)) {
      if (await fenced()) sendJson(res, 413, { error: 'directory-too-large', commit })
      return
    }
    if (res.destroyed) return
    // A tarball upstream finds no tree in, as @preventive/archive refuses
    // one with a symlink past the repository's root, is one the viewer
    // cannot read; one holding another tree is GitHub's answer gone wrong.
    const load = loadRepositoryCodeBody({ repoId, repo, commit, path, tree, listed }, symlinksAbove => upstreamGithub(() => client.getRepoTreeTarball({ repo, tree, symlinksAbove }).catch((err: unknown) => {
      throw err instanceof Error && err.name === 'AssertionError' && err.message.includes(', got no tree: ') ? new GithubApiError(422, 'directory-unreadable') : err
    })))
    res.once('close', load.release)
    const bytes = await load.result
    if (!(await fenced()) || res.destroyed) return
    res.setTimeout(NPM_RESPONSE_IDLE_MS, () => res.destroy())
    res.writeHead(200, {
      'content-type': 'application/json', 'content-encoding': 'br', 'content-length': String(bytes.byteLength),
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
    })
    writeResponse(res, bytes)
  } catch (err) {
    if (res.headersSent || res.destroyed) return
    if (err instanceof GithubApiError) { sendGithubError(res, err); return }
    if (err instanceof NpmPackageError) { sendJson(res, err.status, { error: err.message }); return }
    throw err
  }
}

// GET /api/admin/repositories/history: what the code viewer's History tab
// draws (repository-history.ts), read as browsing is, with the reader's own
// GitHub access, within their grants as the code is. From a revision (`ref`),
// a page at a time (`page`), the commits touching `path` where it names a
// directory, with the branches and tags naming commits on the first page; or,
// with `all`, across the repository's most recently updated branches, which
// needs a GitHub token. A whole repository's history, from a revision or all
// branches, is read from commits a page each, kept by the commit each starts
// at, and those kept glued on (historyFrom); a later page reads on from the
// commits `from` names. The branches and tags naming commits are kept as an
// issue's page is (keptAnswer). Access is checked again once it is read,
// before any of it is sent, with the app's users its authors are
// (github-users.ts).
async function handleRepositoryHistory(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams): Promise<void> {
  const asked = repositoryQuery(res, query)
  if (!asked) return
  const { repoId, ref, path } = asked
  const page = Number(query.get('page') ?? '1')
  const all = query.get('all') === 'true'
  // Every branch's heads read now, not as kept: the client asks so where
  // they miss the commit shown, as a branch moved since may.
  const fresh = query.get('fresh') === 'true'
  // A whole repository's later pages read on from where those before stop:
  // all branches', always; a revision's, where the client names them.
  const from = query.get('from')
  const starts = from === null ? null : historyStarts(from)
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_HISTORY_PAGE || (all && (path !== '' || (page > 1) !== (starts !== null)))
    || (from !== null && (starts === null || path !== '' || page === 1))) { sendJson(res, 400, { error: 'bad-request' }); return }
  const authorize = async (handed = false) => {
    const access = await authorizeRepository(res, deps, cookie, repoId, path, { handed })
    if (access && access.virtualEntries !== null) { sendJson(res, 404, { error: 'no-directory' }); return null }
    return access
  }
  const access = await authorize(true)
  if (!access) return
  let readingPulls: Promise<{ number: number; sha: string }[] | null> = Promise.resolve(null)
  try {
    const reader = await createRepositoryBrowser(deps.config, await repositoryBrowserUser(deps, access.user.id)).reader(access.repo)
    const repo = access.repo.fullName
    const token = reader.readToken()
    // With a token, as GraphQL reads them.
    const pages = historyPages(deps, repoId, token !== null)
    const quiet = <T>(fallback: T) => (err: unknown) => {
      if (deps.config.debug) console.warn('managed: history pull requests read failed:', err)
      return fallback
    }
    // Open pull heads do not depend on the commit history. Start them with
    // it, handling failures immediately even if the history fails first.
    if (token && path === '' && page === 1) {
      readingPulls = keptAnswer(deps, `${repoId}\0openPulls`, () => openPullHeads(repo, token), undefined, fresh).then(answer => answer.value.pulls, quiet(null))
    }
    let body: object
    if (all) {
      if (!token) { sendJson(res, 403, { error: 'github-token-required' }); return }
      // What a later page reads on from, the client knows; whether one may
      // follow, the deepest page says.
      // Asked for afresh, those kept answered as just read: how long till
      // they may be read again (`retryIn`), for the client to ask then.
      const heads = starts ? null : await keptAnswer<AllHeads>(deps, `${repoId}\0heads`, () => repositoryAllHeads(repo, token), undefined, fresh)
      const retryIn = heads && fresh && heads.kept ? heads.at + REPOSITORY_READ_FLOOR_MS - Date.now() : 0
      body = starts ? { all: true, page, commits: (await historyFrom(repo, token, starts, pages)).commits, more: page < MAX_HISTORY_PAGE }
        : { all: true, ...await repositoryAllHistory(repo, token, heads!.value, pages), ...retryIn > 0 ? { retryIn } : {} }
    } else {
      const commit = await reader.commit(ref)
      // The branches and tags naming commits: with a token, every branch All
      // branches reads and the latest tags, kept for both; without, GitHub's
      // first page of each.
      const naming = () => token
        ? keptAnswer<AllHeads>(deps, `${repoId}\0heads`, () => repositoryAllHeads(repo, token)).then(({ value }) => ({
          branches: value.heads.map(({ name, sha }) => ({ name, sha })), tags: value.tags }))
        : keptAnswer(deps, `${repoId}\0refs`, () => repositoryRefTips(repo, token)).then(answer => answer.value)
      const tips = page === 1 ? naming() : null
      // A whole repository's from its commit, or on from those `from` names
      // (a page by its number where none are, as GitHub lists them); a
      // directory's by its number.
      const history = path !== '' || (page > 1 && !starts) ? repositoryHistory(repo, token, commit, path, page)
        : historyFrom(repo, token, starts ?? [commit], pages).then(read => ({ commits: read.commits, more: (starts !== null || read.more) && page < MAX_HISTORY_PAGE }))
      const [read, named] = await Promise.all([history, tips])
      body = { commit, path, page, ...read, ...named }
    }
    // The pull requests squashed into a whole repository's commits, drawn as
    // the merges they were, and on its first page the open ones' heads,
    // naming commits: with a token, as far as GitHub answers them, the
    // history sent all the same where it doesn't. Those GitHub is still
    // looking up SQUASH_WAIT_MS on are left to the lookup, kept alive behind
    // the answer, as a kept answer's read is (`pullsPending`, for the client
    // to ask again).
    const listed = (body as { commits: HistoryCommit[] }).commits
    const none = { pulls: [] as SquashedPull[], pending: false }
    const [squashed, openPulls] = token && path === '' ? await Promise.all([
      squashedPulls(repo, token, listed, historySquashes(deps, repoId), SQUASH_WAIT_MS).then(read => {
        if (read.behind) {
          const behind = read.behind.catch(quiet(null))
          deps.track(behind)
          deps.waitUntil?.(behind)
        }
        return read
      }, quiet(none)),
      readingPulls,
    ]) : [none, null]
    const { pulls } = squashed
    await reader.recheckAccess()
    const current = await authorize()
    if (!current) return
    if (!sameRepository(current.repo, access.repo)) { sendJson(res, 409, { error: 'repository-changed' }); return }
    // Each commit as the tab draws it, its co-authors with it: what Pulse
    // counts of it (its lines, its author's time) not sent.
    const shown = ({ sha, parents, subject, authorName, authorLogin, authorId, coauthors, committedAt }: HistoryCommit) =>
      ({ sha, parents, subject, authorName, authorLogin, authorId: authorId ?? null, coauthors: coauthors ?? [], committedAt })
    sendJson(res, 200, await withAppUsers(deps.db, { ...body, commits: listed.map(shown),
      ...pulls.length > 0 ? { pulls: pulls.map(pull => ({ ...pull, commits: pull.commits.map(shown) })) } : {}, ...squashed.pending ? { pullsPending: true } : {},
      ...openPulls?.length ? { openPulls } : {} }))
  } catch (err) {
    if (err instanceof GithubApiError) { sendGithubError(res, err); return }
    throw err
  } finally {
    // A failed history must not release the request's database lease while
    // its independent pull read is still writing to the cache.
    await readingPulls
  }
}

// GET /api/admin/repositories/changes: the files each commit `shas` names
// changes, as the code viewer's Replay plays them (repository-changes.ts),
// within `path`, each commit's kept whole by the commit (historyChanges);
// read as Replay's reads are (readForReplay).
async function handleRepositoryChanges(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams): Promise<void> {
  const shas = changesAsked(query.get('shas'))
  if (!shas) { sendJson(res, 400, { error: 'bad-request' }); return }
  await readForReplay(res, deps, cookie, query, async (fullName, token, repoId, path) => {
    const changes = await repositoryChanges(fullName, token, shas, historyChanges(deps, repoId))
    return { path, changes: [...changes].map(([sha, read]) => read ? { sha, ...changesWithin(read, path) } : { sha, files: null, more: false }) }
  })
}

// GET /api/admin/repositories/tree: the files commit `commit` holds within
// `path` and their bytes (`sizes`), which Replay starts from and the Treemap
// of a directory too large to open draws (repository-changes.ts
// directoryFiles: the directory's own tree where the commit's is cut short),
// kept whole by the commit and the rules it is read by (historyTreeStore,
// TREES_READ); none (null) for one GitHub has none of. Read as Replay's
// reads are (readForReplay).
async function handleRepositoryTree(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams): Promise<void> {
  const commit = query.get('commit') ?? ''
  if (!/^[a-f\d]{40}$/u.test(commit)) { sendJson(res, 400, { error: 'bad-request' }); return }
  const store = historyTreeStore<CommitTree>(deps.db, deps.config.debug)
  await readForReplay(res, deps, cookie, query, async (fullName, token, repoId, path) => {
    const kept = { read: async (sha: string) => {
      const value = (await store.read(`${repoId}\0${TREES_READ}\0${sha}`))?.value
      return value && Array.isArray(value.files) && Array.isArray(value.sizes) && value.sizes.length === value.files.length ? value : null
    }, write: (sha: string, tree: CommitTree) => store.write(`${repoId}\0${TREES_READ}\0${sha}`, tree, Date.now()) }
    const tree = await directoryFiles(fullName, token, commit, path, kept)
    return { commit, path, ...tree ?? { files: null, sizes: null, cut: false } }
  })
}

// What Replay reads of repository `repoId` within `path` (`read`, with its
// name and the reader's token), as the history is read: with the reader's
// own GitHub access, within their grants as the code is, a directory they
// reach all of, and sent once access is checked again.
async function readForReplay(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams,
  read: (fullName: string, token: string | null, repoId: number, path: string) => Promise<object>): Promise<void> {
  const asked = repositoryQuery(res, query)
  if (!asked) return
  const { repoId, path } = asked
  const authorize = async (handed = false) => {
    const access = await authorizeRepository(res, deps, cookie, repoId, path, { handed })
    if (access && access.virtualEntries !== null) { sendJson(res, 404, { error: 'no-directory' }); return null }
    return access
  }
  const access = await authorize(true)
  if (!access) return
  try {
    const reader = await createRepositoryBrowser(deps.config, await repositoryBrowserUser(deps, access.user.id)).reader(access.repo)
    const body = await read(access.repo.fullName, reader.readToken(), repoId, path)
    await reader.recheckAccess()
    const current = await authorize()
    if (!current) return
    if (!sameRepository(current.repo, access.repo)) { sendJson(res, 409, { error: 'repository-changed' }); return }
    sendJson(res, 200, body)
  } catch (err) {
    if (err instanceof GithubApiError) { sendGithubError(res, err); return }
    throw err
  }
}

// The files repository `repoId`'s commits change, kept by each commit
// (historyChangeStore, repository-changes.ts repositoryChanges).
function historyChanges(deps: ManagedHttpDeps, repoId: number): ChangesStore {
  const store = historyChangeStore<CommitChanges>(deps.db, deps.config.debug)
  const keyOf = (sha: string) => `${repoId}\0${sha}`
  return {
    async read(shas) {
      const kept = await store.readMany(shas.map(keyOf))
      return new Map(shas.flatMap(sha => {
        const value = kept.get(keyOf(sha))?.value
        return value && Array.isArray(value.files) ? [[sha, value] as const] : []
      }))
    },
    write: (sha, changes) => store.write(keyOf(sha), changes, Date.now()),
  }
}

// How long what readWholeRepository read is answered as kept, unread again;
// and how long one read is answered as kept even where it is asked for afresh.
const REPOSITORY_READ_FRESH_MS = 2 * 60_000
const REPOSITORY_READ_FLOOR_MS = 10_000
// How long a history's answer waits on GitHub looking up the pull requests
// squashed into its commits (handleRepositoryHistory).
const SQUASH_WAIT_MS = 1500
// The repositories' reads being read again, behind a kept answer or as asked
// for afresh, by key: one at a time, those asking meanwhile answered by it.
const repositoryRereads = new Map<string, Promise<unknown>>()
// A read GitHub refused, not failed: its credential or the GitHub App's
// permission for it withdrawn (Issues, Pull requests, Checks), the
// repository or what was asked of it gone. What was kept of it goes too.
const refusedRead = (err: unknown) => err instanceof GithubApiError
  && (err.status === 401 || err.status === 403 || err.status === 404 || err.message === 'github-status-403')

// What `read` answers of a repository, kept by `key` (its id first) for every
// reader (repositoryReadStore), each one's access checked as they ask before
// this: answered as kept for REPOSITORY_READ_FRESH_MS, then, while it is
// kept, answered at once and read again behind it for the next to ask, the
// read tracked (serverless, its invocation kept alive till it settles,
// deps.waitUntil); `kept` where it was, or where reading it again
// failed as `keepThrough` lets it. One asked for afresh (`fresh`) is read
// now, unless it was read REPOSITORY_READ_FLOOR_MS since, what was kept
// answered where that read fails. One GitHub refuses to read again is no
// longer kept: the next to ask is refused as GitHub refused it. `at` is when
// what it answers was read.
async function keptAnswer<T extends object>(deps: ManagedHttpDeps, key: string, read: () => Promise<T>,
  keepThrough: (err: unknown) => boolean = () => false, fresh = false): Promise<{ value: T; kept: boolean; at: number }> {
  const store = repositoryReadStore(deps.db, deps.config.debug)
  // One kept longer than a day, not yet removed (pruneKept removes them as
  // others are written), is none.
  const stored = await store.read(key)
  const held = stored && Date.now() - stored.at < REPOSITORY_READ_KEPT_MS ? stored : null
  // Read, and kept as read when it was, which it is said read at.
  const readKept = async () => {
    try {
      const value = await read()
      const at = Date.now()
      await store.write(key, value, at)
      return { value, at }
    } catch (err) {
      if (refusedRead(err)) await store.remove(key)
      throw err
    }
  }
  const reread = () => {
    let reading = repositoryRereads.get(key)
    if (!reading) {
      reading = readKept().finally(() => repositoryRereads.delete(key))
      repositoryRereads.set(key, reading)
    }
    return reading as Promise<{ value: T; at: number }>
  }
  const age = held ? Date.now() - held.at : Infinity
  const now = fresh && age >= REPOSITORY_READ_FLOOR_MS
  if (held && !now) {
    if (age >= REPOSITORY_READ_FRESH_MS && !repositoryRereads.has(key)) {
      // Its failure leaves the kept answer sent until it is a day old, so it is said.
      const behind = reread().catch((err: unknown) => { console.warn('managed: repository read failed:', err) })
      deps.track(behind)
      deps.waitUntil?.(behind)
    }
    return { value: held.value as T, kept: true, at: held.at }
  }
  try {
    return { ...now ? await reread() : await readKept(), kept: false }
  } catch (err) {
    if (held && ((now && !refusedRead(err)) || keepThrough(err))) return { value: held.value as T, kept: true, at: held.at }
    throw err
  }
}

// The pages of repository `repoId`'s history kept (historyPageStore), each by
// the commit it starts at (repository-history.ts historyFrom) and the rules
// its co-authors were read by (commit-coauthors.ts COAUTHORS_READ), those
// telling each commit's co-authors (kept since they are read), and with
// `graphql`, only those read with GraphQL, telling its lines and the accounts
// its co-authors' addresses are (a page GitHub's REST API listed tells
// neither); the rest read again.
function historyPages(deps: ManagedHttpDeps, repoId: number, graphql = false): HistoryPages {
  const store = historyPageStore<HistoryCommit[]>(deps.db, deps.config.debug)
  const keyOf = (top: string) => `${repoId}\0${COAUTHORS_READ}\0${top}`
  const told = (tops: string[], kept: Map<string, { value: HistoryCommit[] }>) => new Map(tops.flatMap(top => {
    const page = kept.get(keyOf(top))?.value
    return Array.isArray(page) && page.every(commit => Array.isArray(commit.coauthors)) && (!graphql || page.every(commit => commit.additions != null))
      ? [[top, page] as const] : []
  }))
  return {
    read: async tops => told(tops, await store.readMany(tops.map(keyOf))),
    async readFirst(first, then) {
      const kept = await store.readFirst(first.map(keyOf), then.map(keyOf))
      return { first: kept.first, pages: told(kept.first ? first : then, kept.found) }
    },
    write: (top, commits) => store.write(keyOf(top), commits, Date.now()),
  }
}

// The pull requests squashed into repository `repoId`'s commits, kept by
// each commit and the rules their commits' co-authors were read by
// (COAUTHORS_READ), null for one none was (repository-squashes.ts
// squashedPulls); one kept before its commits' co-authors were read, read
// again.
function historySquashes(deps: ManagedHttpDeps, repoId: number): Squashes {
  const store = historySquashStore<SquashedPull | null>(deps.db, deps.config.debug)
  const keyOf = (sha: string) => `${repoId}\0${COAUTHORS_READ}\0${sha}`
  return {
    async read(shas) {
      const kept = await store.readMany(shas.map(keyOf))
      return new Map(shas.flatMap(sha => {
        const entry = kept.get(keyOf(sha))
        return entry && (entry.value === null || (Array.isArray(entry.value.commits) && entry.value.commits.every(commit => Array.isArray(commit.coauthors))))
          ? [[sha, entry.value] as const] : []
      }))
    },
    write: (sha, pull) => store.write(keyOf(sha), pull, Date.now()),
  }
}

// What the whole of repository `repoId` gives in GraphQL (`read`, with its
// name and a token), read as browsing is, with the reader's own GitHub
// access: only by a reader whose grants reach all of it, with a token, and
// sent once access is checked again after it is read; what `key` names kept
// (keptAnswer), sent as kept, its reader's access checked as they ask; with
// `readAt`, when it was read from GitHub, one kept as old as it was kept, so
// that a reader holding two reads of the same can tell the later.
async function readWholeRepository(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, repoId: number,
  read: (fullName: string, token: string) => Promise<object>, key: string | null = null, readAt = false): Promise<void> {
  await answerWholeRepository(res, deps, cookie, repoId, async (fullName, token) => {
    const { value, kept, at } = key === null ? { value: await read(fullName, token), kept: false, at: Date.now() }
      : await keptAnswer(deps, `${repoId}\0${key}`, () => read(fullName, token))
    return { value: readAt ? { ...value, readAt: at } : value, kept }
  })
}

// What `answer` gives of the whole of repository `repoId` (with its name and
// a token), as readWholeRepository reads it: sent at once where it was kept,
// else once access is checked again, with the app's users it names
// (github-users.ts), never kept with it; or what `unread` tells of it, the
// app's alone, once the app's access is checked, GitHub then never asked.
async function answerWholeRepository(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, repoId: number,
  answer: (fullName: string, token: string, user: StoredUser) => Promise<{ value: object; kept: boolean }>,
  unread: () => Promise<object | null> = () => Promise.resolve(null)): Promise<void> {
  const access = await wholeRepositoryAccess(deps, cookie, repoId, { handed: true })
  if ('error' in access) { sendRefusal(res, access); return }
  const told = await unread()
  if (told) { sendJson(res, 200, await withAppUsers(deps.db, told)); return }
  const read = await readWholeRepositoryOf(deps, access, answer, () => wholeRepositoryAccess(deps, cookie, repoId))
  if ('error' in read) { sendRefusal(res, read); return }
  sendJson(res, 200, await withAppUsers(deps.db, read.value))
}

// What a request is refused, as its answer tells it.
type Refusal = { status: number; error: string; retryAfter?: number }
const refusal = (status: number, error: string, retryAfter?: number | null): Refusal => ({ status, error, ...retryAfter == null ? {} : { retryAfter } })
function sendRefusal(res: ServerResponse, { status, error, retryAfter }: Refusal) {
  sendJson(res, status, { error }, retryAfter == null ? {} : { 'retry-after': String(retryAfter) })
}
// The whole of repository `repoId`, where the session `cookie` names may
// read all of it, and who reads it; else why not: none of it
// (`no-repository`), or only some (`no-directory`).
type WholeAccess = { repo: SelectedRepo; user: StoredUser }
async function wholeRepositoryAccess(deps: ManagedHttpDeps, cookie: string | undefined, repoId: number, { handed = false } = {}): Promise<WholeAccess | Refusal> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now(), { handed })
  if (s == null) return refusal(401, 'unauthenticated')
  if (!roleAtLeast(s.user.role, 'view')) return refusal(403, 'forbidden')
  return wholeAccessIn(await repositoryGrants(deps, s.user), s.user, repoId)
}
function wholeAccessIn(grants: Awaited<ReturnType<typeof repositoryGrants>>, user: StoredUser, repoId: number): WholeAccess | Refusal {
  const access = repositoryAccessIn(grants, repoId, '')
  if (!access) return refusal(404, 'no-repository')
  if (access.virtualEntries !== null) return refusal(404, 'no-directory')
  return { repo: access.repo, user }
}
// What `answer` reads of the whole of the repository `access` lets its
// reader read, with their own GitHub access: as kept, else with that access
// and `reauthorize`'s checked again after; else why it was refused.
async function readWholeRepositoryOf<T>(deps: ManagedHttpDeps, access: WholeAccess, answer: (fullName: string, token: string, user: StoredUser) => Promise<{ value: T; kept: boolean }>,
  reauthorize: () => Promise<WholeAccess | Refusal>): Promise<{ value: T; kept: boolean } | Refusal> {
  try {
    const reader = await createRepositoryBrowser(deps.config, await repositoryBrowserUser(deps, access.user.id)).reader(access.repo)
    const token = reader.readToken()
    if (!token) return refusal(403, 'github-token-required')
    const answered = await answer(access.repo.fullName, token, access.user)
    if (answered.kept) return answered
    await reader.recheckAccess()
    const current = await reauthorize()
    if ('error' in current) return current
    if (!sameRepository(current.repo, access.repo)) return refusal(409, 'repository-changed')
    return answered
  } catch (err) {
    if (err instanceof GithubApiError) return refusal(err.status === 401 ? 502 : err.status, err.message, err.retryAfter)
    throw err
  }
}

// GET /api/admin/repositories/issues: what the code viewer's Issues and Pull
// requests tabs show (repository-issues.ts): `kind`'s open or closed
// (`state`), a page at a time, on from the cursor `after` names. They are
// the whole repository's, read as readWholeRepository reads them, kept with
// open pull requests' commits, which they never tell (teamOpenPulls reads
// them).
async function handleRepositoryIssues(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams): Promise<void> {
  const repoId = Number(query.get('repoId'))
  const kind = query.get('kind')
  const state = query.get('state') ?? 'open'
  const after = query.get('after')
  if (!Number.isSafeInteger(repoId) || repoId <= 0 || (kind !== 'issues' && kind !== 'pulls') || (state !== 'open' && state !== 'closed')
    || (after !== null && !ISSUES_CURSOR.test(after))) { sendJson(res, 400, { error: 'bad-request' }); return }
  await answerWholeRepository(res, deps, cookie, repoId, async (fullName, token) => {
    const { value: { commits: _commits, ...page }, kept, at } = await keptAnswer(deps, `${repoId}\0issues\0${ISSUES_READ_VERSION}\0${kind}\0${state}\0${after ?? ''}`,
      async () => ({ kind, state, ...await repositoryIssues(fullName, token, kind, state, after) }))
    return { value: { ...page, readAt: at }, kept }
  })
}

// GET /api/admin/repositories/agents: what the code viewer's Agents tab
// reconstructs agents' sessions from (repository-agents.ts): a page
// of pull requests on from the cursor `pulls` names, and of the default
// branch's commits on from `commits`, the first page, naming neither, with
// issues and branches. They are the whole repository's (readWholeRepository).
async function handleRepositoryAgents(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams): Promise<void> {
  const repoId = Number(query.get('repoId'))
  const cursors = { pulls: query.get('pulls'), commits: query.get('commits') }
  if (!Number.isSafeInteger(repoId) || repoId <= 0 || (cursors.pulls !== null && !ISSUES_CURSOR.test(cursors.pulls))
    || (cursors.commits !== null && !COMMITS_CURSOR.test(cursors.commits))) {
    sendJson(res, 400, { error: 'bad-request' }); return
  }
  await readWholeRepository(res, deps, cookie, repoId, (fullName, token) => repositoryAgents(fullName, token, cursors),
    `agents\0${AGENTS_READ_VERSION}\0${cursors.pulls ?? ''}\0${cursors.commits ?? ''}`)
}

// GET /api/admin/repositories/item: the issue or pull request numbered
// `number`, as the code viewer's popup for it shows it (repository-issues.ts
// repositoryItem). It is the whole repository's (readWholeRepository).
async function handleRepositoryItem(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams): Promise<void> {
  const repoId = Number(query.get('repoId'))
  const number = itemNumber(query)
  if (!Number.isSafeInteger(repoId) || repoId <= 0 || number === null) { sendJson(res, 400, { error: 'bad-request' }); return }
  await readWholeRepository(res, deps, cookie, repoId, (fullName, token) => repositoryItem(fullName, token, number), `item\0${ISSUES_READ_VERSION}\0${number}`, true)
}

// The issue's or pull request's number a request names, as GraphQL takes one
// (an Int, at most 2³¹ − 1); null for none.
function itemNumber(query: URLSearchParams): number | null {
  const number = Number(query.get('number'))
  return /^[1-9]\d{0,9}$/u.test(query.get('number') ?? '') && number <= 2 ** 31 - 1 ? number : null
}

// GET /api/admin/repositories/pull-dependencies: the package versions pull
// request `number`'s lockfiles add (pull-dependencies.ts), what its base's and head's
// commits tell kept by them (pullDependencyKept), its `number` with them.
// They are the whole repository's (answerWholeRepository), the commits they
// are of kept by its number as its popup's item is, its head moving with each
// push, what they tell kept by them alone, not again. With `review=1`,
// as an open one's are asked, where the repository reviews dependencies,
// each version's review (pull-dependency-reviews.ts), read afresh as each
// asks, reviews being published meanwhile; its baseline kept, where the host
// registered no reviewed dependencies, which are asked in its place.
// Up to MAX_ASKED_PULLS pull requests asked together (`numbers=1,2,3`) are
// answered together, as many read at once as PULLS_AT_ONCE, `{ pulls }`,
// each's answer, else `{ number, error }` where GitHub fails it, with one
// check of its access before and one after, but where each was kept.
const MAX_ASKED_PULLS = 20
const PULLS_AT_ONCE = 3
async function handleRepositoryPullDependencies(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams): Promise<void> {
  const repoId = Number(query.get('repoId'))
  const review = query.get('review') === '1'
  const listed = query.get('numbers')
  const numbers = listed === null ? [itemNumber(query)] : listed.split(',').map(text => itemNumber(new URLSearchParams({ number: text })))
  if (!Number.isSafeInteger(repoId) || repoId <= 0 || numbers.length > MAX_ASKED_PULLS || numbers.some(number => number === null) || new Set(numbers).size < numbers.length
    || !['1', null].includes(query.get('review'))) { sendJson(res, 400, { error: 'bad-request' }); return }
  await answerWholeRepository(res, deps, cookie, repoId, async (fullName, token, user) => {
    if (listed === null) return pullDependencyAnswer(deps, fullName, token, user, repoId, numbers[0]!, review)
    const answers = await eachOf(numbers as number[], PULLS_AT_ONCE, number => pullDependencyAnswer(deps, fullName, token, user, repoId, number, review).catch((err: unknown) => {
      // GitHub asked, though it failed: its access asked again after.
      if (err instanceof GithubApiError) return { value: { number, error: err.message }, kept: false }
      throw err
    }))
    return { value: { pulls: answers.map(({ value }) => value) }, kept: answers.every(({ kept }) => kept) }
  })
}

// Pull request `number`'s answer, as the endpoint gives it, and whether all
// of it was kept, GitHub asked for none of it: its base's and head's commits
// as a page of its repository's open pull requests read them (`commits`,
// kept and read again as that page is), else as kept by its number.
async function pullDependencyAnswer(deps: ManagedHttpDeps, fullName: string, token: string, user: StoredUser, repoId: number, number: number, review: boolean,
  commits?: PullCommits) {
  const kept = pullDependencyKept(deps, repoId)
  const reading: { told?: PullDependencies } = {}
  const answered = commits ? { value: { commits: `${commits.base}...${commits.head}` }, kept: true }
    : await keptAnswer(deps, `${repoId}\0pull-commits\0${PULL_DEPENDENCIES_READ}\0${number}`, async () => {
      const read = await pullDependenciesAt(fullName, token, number, kept)
      reading.told = read.told
      return { commits: read.commits }
    })
  // What its commits tell, as read, else as kept by them, else, no longer
  // kept, read again: by those given, without asking GitHub for them.
  const held = reading.told ?? (typeof answered.value.commits === 'string' ? await kept.read(answered.value.commits) : null)
  const pulled = { number, ...held ?? (await pullDependenciesAt(fullName, token, number, kept, undefined, commits)).told }
  // Where its review is on, those of lockfiles it leaves out told to none,
  // whoever asks.
  const setting = await deps.db.repoDependencyReview(repoId)
  const scoped = setting?.enabled ? heldDependencies(pulled, setting.lockfiles) : pulled
  const now = review ? await deps.db.repoDependencyReviewState(repoId, user.id, reviewedPackages(scoped)) : null
  // Its review by the lockfiles they were told by, though they have changed
  // since; turned off meanwhile, all of them, as where it is off.
  const state = now && setting?.enabled ? { ...now, lockfiles: setting.lockfiles } : now
  const told = review && !now && setting?.enabled && !(await deps.db.repoDependencyReview(repoId))?.enabled ? pulled : scoped
  const reviewed = deps.reviewedDependencies ?? null
  const { baseline, unread, error } = state && !reviewed ? await baselineFor(fullName, token, repoId, state, baselineKept(deps), lockfileKept(deps, repoId))
    : { baseline: null, unread: [], error: null }
  // Its comments read for reviews, where the host reads them, while it is
  // open (pull-comment-reviews.ts reads whether it is with them).
  const parse = reviewed?.parseComments
  const comments = state && parse ? commentReviews({ fullName, number, token, parse, reviewers: accounts => repoReviewers(deps, repoId, accounts) }) : null
  // The comment the host formats of the reader's reviews of its versions, for its copy button.
  const formatted = await formattedPull(reviewed, deps.db, user.id, told, state, { repository: fullName, number })
  return { value: { number: told.number, ...await reviewedDependencies(told, state, { baseline, baselineUnread: unread, baselineError: error, reviewed, commentReviews: comments }),
    ...formatted ? { formatted } : {} }, kept: answered.kept && held !== null }

}

// GET /api/admin/repositories/branch-dependencies: what the lockfiles of the
// repository's default branch lock that wants review, where its review is in
// effect for the reader (`review`, else none, told without asking GitHub
// where it reviews none), as a team's Dependencies tab shows it: its head, as
// its pulse reads it, kept a while; every lockfile there its review holds to
// (lockfile-scope.ts, commit-lockfiles.ts) as one directory, its versions as
// a pull request's others are (pull-dependency-reviews.ts), each left unread
// a directory of its own failing the review, as a pull request's are. Kept,
// its access not asked again, where its head was kept and its lockfiles and
// baseline held or kept (lockfileKept), GitHub asked for none of them.
async function handleRepositoryBranchDependencies(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams): Promise<void> {
  const repoId = Number(query.get('repoId'))
  if (!Number.isSafeInteger(repoId) || repoId <= 0) { sendJson(res, 400, { error: 'bad-request' }); return }
  await answerWholeRepository(res, deps, cookie, repoId, (fullName, token, user) => branchDependencyAnswer(deps, fullName, token, user, repoId),
    async () => (await deps.db.repoDependencyReview(repoId))?.enabled ? null : { review: null })
}

// The default branch's answer, as GET branch-dependencies gives it, and
// whether all of it was kept, GitHub asked for none of it; its review's
// setting as read already (`known`), where it was.
async function branchDependencyAnswer(deps: ManagedHttpDeps, fullName: string, token: string, user: StoredUser, repoId: number,
  known?: RepoDependencyReview | null): Promise<{ value: object; kept: boolean }> {
  const headRead = await keptAnswer(deps, `${repoId}\0pulse-head`, async () => ({ sha: await defaultHead(fullName, token) }))
  const head = headRead.value.sha
  if (!head) return { value: { head: null, review: null }, kept: false }
  const asked: GithubAsked = { github: !headRead.kept }
  // Those its review holds to alone read, as many as are read of them.
  const setting = known === undefined ? await deps.db.repoDependencyReview(repoId) : known
  if (!setting?.enabled) return { value: { head, review: null }, kept: false }
  const reads = lockfileKept(deps, repoId)
  const read = await lockedAt(fullName, token, head, reads, path => heldTo(setting.lockfiles, path), asked)
  const { packages, paths } = lockedIn(read)
  const told = { base: head, head, cut: false, lockfiles: [{ paths, added: [], more: 0, locked: packages.slice(0, MAX_LOCKED), moreLocked: Math.max(0, packages.length - MAX_LOCKED) },
    ...read.unread.map(path => ({ paths: [path], error: lockfileFormat(path) === 'bun' ? 'lockfile-unsupported' : 'lockfile-unreadable' }))] }
  const now = await deps.db.repoDependencyReviewState(repoId, user.id, reviewedPackages(told))
  if (!now) return { value: { head, review: null }, kept: !asked.github }
  // Told by the lockfiles it held to as they were read, though they have
  // changed since.
  const state = { ...now, lockfiles: setting.lockfiles }
  const reviewed = deps.reviewedDependencies ?? null
  const { baseline, unread: baselineUnread, error } = reviewed ? { baseline: null, unread: [], error: null }
    : await baselineFor(fullName, token, repoId, state, baselineKept(deps), reads, asked)
  return { value: await reviewedDependencies(told, state, { baseline, baselineUnread, baselineError: error, reviewed }), kept: !asked.github }
}

// GET /api/admin/repositories/lockfiles: the lockfiles of the repository's
// default branch its dependency review reads (commit-lockfiles.ts), by their
// paths, with their formats, at its head, as its pulse reads it, for its
// settings to name those it holds to (lockfile-scope.ts).
async function handleRepositoryLockfiles(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams): Promise<void> {
  const repoId = Number(query.get('repoId'))
  if (!Number.isSafeInteger(repoId) || repoId <= 0) { sendJson(res, 400, { error: 'bad-request' }); return }
  await answerWholeRepository(res, deps, cookie, repoId, async (fullName, token) => {
    const head = (await keptAnswer(deps, `${repoId}\0pulse-head`, async () => ({ sha: await defaultHead(fullName, token) }))).value.sha
    return { value: { head, lockfiles: head ? (await lockfilesAt(fullName, token, head, lockfileKept(deps, repoId))).map(({ path, format }) => ({ path, format })) : [] }, kept: false }
  })
}

// GET /api/teams/:id/dependencies: what the team's Dependencies tab shows
// (team-dependencies.js), in one request rather than one a repository, a
// page of its pull requests and a batch of their dependencies: of each of
// the team's repositories (those `repoIds` names alone, where it names
// some), as lines of JSON as each is read, as the endpoints of each read
// them: its default branch's dependencies and its open pull requests
// (`{ repoId, branch, pulls: { items, more } }`) where its review is in
// effect for the reader, else `{ repoId, branch: null }`, as for one they
// may read only some of, or `{ repoId, error, status }`; then its pull
// requests' dependencies, of those changing a lockfile or that may,
// TEAM_PULLS_TOGETHER at a time (`{ repoId, dependencies }`); each line of
// dependencies with the lines their versions wanting reviews change, where
// they are counted already (`deltas`, npm-delta.ts keptNpmDeltas), told
// before the rows asking for them are drawn. Last, `{ done: true
// }`, or, its time up, `{ done: false, unread }`, the repositories left for
// the reader to ask for again. The team's repositories, the reader's grants
// and the repositories' reviews read once, those reviewing none answered at
// once, GitHub asked nothing of them; each read with GitHub has its access
// checked again after (readWholeRepositoryOf), and the reader's session
// before each line, their team and grants before each telling a
// repository's.
const TEAM_REPOSITORIES_AT_ONCE = 4
const TEAM_DEPENDENCIES_MS = 240_000
const TEAM_PULL_PAGES = 20
const TEAM_PULLS_TOGETHER = 20
const PARTIAL_ACCESS = new Set(['no-directory', 'no-repository'])
type TeamDependencyLine = Record<string, unknown> & { repoId?: number }
type TeamPull = { number: number; touchesLockfile?: boolean | null }
async function handleTeamDependencies(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, s: { session: ManagedSession; user: StoredUser },
  teamId: string, query: URLSearchParams): Promise<void> {
  const deadline = Date.now() + TEAM_DEPENDENCIES_MS
  const named = query.get('repoIds')
  const only = named === null ? null : new Set(named.split(',').map(Number))
  if (only && (only.size === 0 || only.size > 1000 || [...only].some(id => !Number.isSafeInteger(id) || id <= 0))) { sendJson(res, 400, { error: 'bad-request' }); return }
  const snapshot = await teamSnapshot(deps.db, s.session.id, teamId)
  const repoIds = [...new Set(snapshot.repositories.map(repo => repo.repoId))].filter(id => !only || only.has(id))
  const grants = await repositoryGrants(deps, s.user)
  const settings = await deps.db.getRepoDependencyReviews(repoIds)
  const out = openLines(res)
  let stopped = false
  // Lines written once their reader still reads them as at the start, the
  // stream running minutes and a kept answer asking nothing again: their
  // session theirs, and, where a line tells what a repository holds, the
  // team still theirs and holding it, their grants still reaching the whole
  // of it. None, and the answer cut short, where not, or the reader is gone.
  const send = async (...lines: TeamDependencyLine[]) => {
    if (stopped) return false
    const now = await readSession(deps.config, deps.db, cookie, Date.now())
    if (now?.user.id !== s.user.id || !roleAtLeast(now.user.role, 'view')) stopped = true
    const telling = lines.filter(line => line.repoId !== undefined && (line['branch'] || line['dependencies'])).map(line => line.repoId!)
    if (!stopped && telling.length > 0 && !await stillReads(now!.user, telling)) stopped = true
    for (const line of lines) if (stopped || !await out.write(line)) stopped = true
    if (stopped) out.cut()
    return !stopped
  }
  const stillReads = async (user: StoredUser, ids: number[]) => {
    const team = await teamSnapshot(deps.db, s.session.id, teamId).catch((err: unknown) => {
      if (err instanceof TeamReportsError) return null
      throw err
    })
    if (!team) return false
    const current = await repositoryGrants(deps, user)
    return ids.every(id => team.repositories.some(repo => repo.repoId === id) && !('error' in wholeAccessIn(current, user, id)))
  }
  const reading: { access: WholeAccess; setting: RepoDependencyReview }[] = []
  const answered: TeamDependencyLine[] = []
  for (const repoId of repoIds) {
    const access = wholeAccessIn(grants, s.user, repoId), setting = settings.get(repoId)
    if ('error' in access || !setting?.enabled) answered.push({ repoId, branch: null })
    else reading.push({ access, setting })
  }
  if (answered.length > 0 && !await send(...answered)) return
  const done = await eachOf(reading, TEAM_REPOSITORIES_AT_ONCE, ({ access, setting }) => stopped || Date.now() > deadline ? Promise.resolve(false)
    : teamRepositoryDependencies(deps, access, setting, deadline, send, () => wholeRepositoryAccess(deps, cookie, access.repo.repoId)))
  if (stopped) return
  const unread = reading.filter((_, at) => !done[at]).map(({ access }) => access.repo.repoId)
  if (!await send(unread.length === 0 ? { done: true } : { done: false, unread })) return
  await out.end()
}

// A repository's lines of its team's Dependencies, as handleTeamDependencies
// tells them; whether all were written, none left for its time.
async function teamRepositoryDependencies(deps: ManagedHttpDeps, access: WholeAccess, setting: RepoDependencyReview, deadline: number,
  send: (...lines: TeamDependencyLine[]) => Promise<boolean>, reauthorize: () => Promise<WholeAccess | Refusal>): Promise<boolean> {
  const repoId = access.repo.repoId
  type Read = { branch: object | null; pulls?: { items: TeamPull[]; more: boolean }; commits?: Map<number, PullCommits> }
  const read = await readWholeRepositoryOf<Read>(deps, access, async (fullName, token, user) => {
    const branch = await branchDependencyAnswer(deps, fullName, token, user, repoId, setting)
    if (!(branch.value as { review?: unknown }).review) return { value: { branch: null }, kept: branch.kept }
    const pulls = await teamOpenPulls(deps, repoId, fullName, token)
    return { value: { branch: branch.value, pulls: { items: pulls.items, more: pulls.more }, commits: pulls.commits }, kept: branch.kept && pulls.kept }
  }, reauthorize)
  if ('error' in read) return send({ repoId, ...PARTIAL_ACCESS.has(read.error) ? { branch: null } : { error: read.error, status: read.status } })
  const { branch, pulls, commits } = read.value
  if (!branch) return send({ repoId, branch: null })
  if (!await send({ repoId, branch, pulls, ...await withDeltas(deps, [branch]) })) return false
  // Each by the commits its page names, where it names them, GitHub not asked
  // for them (pullDependencyAnswer); never told.
  const numbers = pulls!.items.filter(item => item.touchesLockfile === true || item.touchesLockfile === null).map(item => item.number)
  for (let at = 0; at < numbers.length; at += TEAM_PULLS_TOGETHER) {
    if (Date.now() > deadline) return false
    const batch = numbers.slice(at, at + TEAM_PULLS_TOGETHER)
    const pulled = await readWholeRepositoryOf(deps, access, async (fullName, token, user) => {
      const answers = await eachOf(batch, PULLS_AT_ONCE, number => pullDependencyAnswer(deps, fullName, token, user, repoId, number, true, commits?.get(number)).catch((err: unknown) => {
        // GitHub asked, though it failed: its access asked again after.
        if (err instanceof GithubApiError) return { value: { number, error: err.message }, kept: false }
        throw err
      }))
      return { value: answers.map(({ value }) => value), kept: answers.every(({ kept }) => kept) }
    }, reauthorize)
    const dependencies = 'error' in pulled ? batch.map(number => ({ number, error: pulled.error })) : pulled.value
    if (!await send({ repoId, dependencies, ...await withDeltas(deps, dependencies) })) return false
  }
  return true
}
const withDeltas = async (deps: ManagedHttpDeps, answers: object[]) => {
  const deltas = await teamDeltas(deps, answers)
  return deltas.length > 0 ? { deltas } : {}
}

// A commit's or a blob's id, as GitHub names one.
const OBJECT_ID = /^[a-f\d]{40}$/u

// A repository's open pull requests, as many pages of them as
// TEAM_PULL_PAGES, each read and kept as GET issues reads it; each's base's
// and head's commits as its page has them (`commits`, by its number), where
// it has them; whether it has more, and whether all were kept.
async function teamOpenPulls(deps: ManagedHttpDeps, repoId: number, fullName: string, token: string) {
  const items: TeamPull[] = []
  const commits = new Map<number, PullCommits>()
  let after: string | null = null, kept = true
  for (let page = 0; page < TEAM_PULL_PAGES; page++) {
    const cursor = after
    const answer = await keptAnswer(deps, `${repoId}\0issues\0${ISSUES_READ_VERSION}\0pulls\0open\0${cursor ?? ''}`,
      async () => ({ kind: 'pulls', state: 'open', ...await repositoryIssues(fullName, token, 'pulls', 'open', cursor) }))
    kept &&= answer.kept
    const value = answer.value as { items?: unknown; more?: unknown; after?: unknown; commits?: unknown }
    items.push(...(Array.isArray(value.items) ? value.items : []).filter(item => Number.isSafeInteger(item?.number) && item.number > 0))
    for (const pull of Array.isArray(value.commits) ? value.commits as { number?: unknown; base?: unknown; head?: unknown }[] : []) {
      const { number, base, head } = pull ?? {}
      if (Number.isSafeInteger(number) && typeof base === 'string' && OBJECT_ID.test(base) && typeof head === 'string' && OBJECT_ID.test(head)) {
        commits.set(number as number, { base, head })
      }
    }
    if (value.more !== true || typeof value.after !== 'string') return { items, commits, more: false, kept }
    after = value.after
  }
  return { items, commits, more: true, kept }
}

// The lines the versions wanting reviews of `answers` change, as their rows
// show them (npm-delta.js deltaBase), where they are counted already: of
// public versions alone, those npm answered for in a day (npmVersionStore),
// their integrities those npmDelta keys them by. `[name, version, base,
// delta]` each, none counted here.
async function teamDeltas(deps: ManagedHttpDeps, answers: object[]) {
  const asked = new Map<string, [string, string, string]>()
  for (const answer of answers as { lockfiles?: { added?: unknown; unreviewed?: unknown }[]; review?: { required?: number } }[]) {
    const required = answer.review?.required
    if (!Number.isSafeInteger(required)) continue
    for (const pkg of (answer.lockfiles ?? []).flatMap(dir => [...Array.isArray(dir.added) ? dir.added : [], ...Array.isArray(dir.unreviewed) ? dir.unreviewed : []]) as
      { name?: unknown; version?: unknown; source?: unknown; was?: unknown; reviews?: unknown; rejected?: unknown; baseline?: unknown; reviewed?: unknown; unsupported?: unknown }[]) {
      if (pkg.source !== 'registry' || typeof pkg.name !== 'string' || typeof pkg.version !== 'string' || !isExactVersion(pkg.version)) continue
      if (pkg.unsupported || pkg.baseline || pkg.reviewed || typeof pkg.reviews !== 'number' || (pkg.reviews >= required! && !pkg.rejected)) continue
      const was = Array.isArray(pkg.was) ? pkg.was.find(prior => typeof prior === 'string' && prior !== pkg.version) as string | undefined : undefined
      asked.set(`${pkg.name}\0${pkg.version}\0${was ?? '(empty)'}`, [pkg.name, pkg.version, was ?? '(empty)'])
    }
  }
  if (asked.size === 0) return []
  const versions = [...asked.values()].flatMap(([name, version, base]) => [{ name, version }, ...base === '(empty)' || !isExactVersion(base) ? [] : [{ name, version: base }]])
  const kept = await npmVersionStore(deps.db, deps.config.debug).readMany!(versions)
  const integrity = (name: string, version: string) => {
    const hit = kept.get(`${name}@${version}`)
    const dist = hit && Date.now() - hit.at < VERSION_KEPT_MS ? hit.json['dist'] : null
    return typeof dist === 'object' && dist !== null && typeof (dist as { integrity?: unknown }).integrity === 'string' ? (dist as { integrity: string }).integrity : null
  }
  const sides = [...asked.values()].flatMap(([name, version, base]) => {
    const against = base === '(empty)' ? null : integrity(name, base), other = integrity(name, version)
    return other && (base === '(empty)' || against) ? [{ name, version, base, key: [against, other] as [string | null, string] }] : []
  })
  if (sides.length === 0) return []
  const counted = await keptNpmDeltas(sides.map(({ key }) => key), npmDeltaStore<NpmDelta>(deps.db, deps.config.debug))
  return sides.flatMap(({ name, version, base, key: [against, other] }) => {
    const delta = counted.get(`${against ?? '(empty)'}\0${other}`)
    return delta ? [[name, version, base, delta]] : []
  })
}

// The app's users `accounts` are, by their logins in lower case, of those
// who publish reviews to a team counting for repository `repoId`.
async function repoReviewers(deps: ManagedHttpDeps, repoId: number, accounts: { login: string; githubId: number | null }[]) {
  const users = await deps.db.listUsersByAccount(accounts)
  const counted = await deps.db.listRepoReviewers(repoId, [...new Set(Object.values(users).map(user => user.id))])
  return new Map(Object.entries(users).flatMap(([login, user]) => counted.has(user.id) ? [[login.toLowerCase(), user.id] as const] : []))
}

// The versions repository lockfiles locked at the commits their dependencies
// are reviewed since, kept by each (reviewBaselineStore).
function baselineKept(deps: ManagedHttpDeps): ReviewBaselineStore {
  const store = reviewBaselineStore(deps.db, deps.config.debug)
  return {
    async read(key) {
      const value = (await store.read(key))?.value
      const strings = (list: unknown) => Array.isArray(list) && list.every(item => typeof item === 'string')
      return strings(value?.versions) && strings(value?.unread) ? value : null
    },
    write: (key, baseline) => store.write(key, baseline, Date.now()),
  }
}

// What repository `repoId`'s pull requests' lockfiles add, kept by the
// commits of each's base and head and the rules they were told by
// (PULL_DEPENDENCIES_READ, pullDependencyStore).
function pullDependencyKept(deps: ManagedHttpDeps, repoId: number): PullDependencyStore {
  const store = pullDependencyStore<PullDependencies>(deps.db, deps.config.debug)
  const keyOf = (commits: string) => `${repoId}\0${PULL_DEPENDENCIES_READ}\0${commits}`
  return {
    async read(commits) {
      const value = (await store.read(keyOf(commits)))?.value
      return value && Array.isArray(value.lockfiles) ? value : null
    },
    write: (commits, told) => store.write(keyOf(commits), told, Date.now()),
  }
}

// What reading repository `repoId`'s lockfiles for its dependency review
// keeps, by the rules they were read by (PULL_DEPENDENCIES_READ,
// lockfileReadStore): each commit's listing, and each lockfile's read, of
// those GitHub gave (pull-dependencies.ts LockfileStore). One kept otherwise
// is none.
function lockfileKept(deps: ManagedHttpDeps, repoId: number): LockfileStore {
  const listings = lockfileReadStore<ListedLockfile[]>(deps.db, 'listings', deps.config.debug)
  const lockfiles = lockfileReadStore<LockfileRead>(deps.db, 'lockfiles', deps.config.debug)
  const keyOf = (key: string) => `${repoId}\0${PULL_DEPENDENCIES_READ}\0${key}`
  return {
    listings: {
      async read(commit) {
        const value: unknown = (await listings.read(keyOf(commit)))?.value
        return Array.isArray(value) && value.every(item => typeof item?.path === 'string' && typeof item.format === 'string' && lockfileFormat(item.path) === item.format
          && typeof item.sha === 'string' && OBJECT_ID.test(item.sha)) ? value : null
      },
      write: (commit, listed) => listings.write(keyOf(commit), listed, Date.now()),
    },
    lockfiles: {
      async read(key) {
        const value = (await lockfiles.read(keyOf(key)))?.value as { packages?: unknown; error?: unknown } | null | undefined
        return value && (Array.isArray(value.packages) || value.error === 'lockfile-unreadable') ? value as LockfileRead : null
      },
      write: (key, read) => lockfiles.write(keyOf(key), read, Date.now()),
    },
  }
}

// GET /api/admin/repositories/pulse: what the code viewer's Pulse tab shows
// (repository-pulse.ts): the default branch's year, counted from its commits
// (pulseCommits), and the pull requests and issues of the last `weeks`
// weeks, each kept apart. A year not read whole yet answers how many of its
// commits are (`reading`), or of the pull requests merged in it (`pulls`);
// one GitHub's statistics count, while it is still computing them,
// `pending`, for the client to ask again. They are the whole repository's
// (readWholeRepository).
async function handleRepositoryPulse(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams): Promise<void> {
  const repoId = Number(query.get('repoId'))
  const weeks = Number(query.get('weeks') ?? '4')
  if (!Number.isSafeInteger(repoId) || repoId <= 0 || !PULSE_WEEKS.includes(weeks)) { sendJson(res, 400, { error: 'bad-request' }); return }
  await answerWholeRepository(res, deps, cookie, repoId, async (fullName, token) => {
    const [period, year] = await Promise.all([
      keptAnswer(deps, `${repoId}\0pulse\0${weeks}`, () => repositoryActivity(fullName, token, weeks)),
      pulseCommits(deps, repoId, fullName, token),
    ])
    return { value: { weeks, ...period.value, stats: year.stats && periodStats(year.stats, weeks), reading: year.reading, pulls: year.pulls,
      pending: year.pending }, kept: period.kept && year.kept }
  })
}

// The default branch's year (repository-pulse.ts commitStats), counted from
// its commits as the Commits tab keeps them, with their lines
// (yearCommits): kept by the head it was read from (repositoryReadStore),
// that head kept as an issue's page is; its commits merged from an agent's
// pull request told by those merged (agentMerges), kept as read, the rest
// read on by the next answer as the year's commits are, and read again as
// an answer kept is, a label changing whose a pull request is without
// moving the head, the year counted again where what they bring changed.
// A year not read whole yet is how many of its commits are (`reading`), or
// of the pull requests merged (`pulls`), beside the year last counted from
// an earlier head over the same weeks, where one is kept, so that a head
// moved on shows the year as it was till it is counted again; one past
// YEAR_COMMITS is GitHub's statistics' (repositoryStats, repositoryLines),
// kept together as an issue's page is and through GitHub computing them
// again, `pending` while it first computes them, the year last counted
// beside it so too.
// A day as a pulse's items are narrowed by (YYYY-MM-DD, UTC), when it starts;
// a GitHub login, as many of them as PULSE_AUTHORS.
const PULSE_DAY = /^\d{4}-\d{2}-\d{2}$/u
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}(?:\[bot\])?$/iu
const PULSE_AUTHORS = 10
const pulseDay = (value: string | null) => {
  const at = value !== null && PULSE_DAY.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN
  return Number.isSafeInteger(at) ? at : null
}

// GET /api/admin/repositories/pulse/items: the Pulse tab's pull requests and
// issues narrowed to a picked day or week (`from` to `to`, else on from
// `from`) and the GitHub accounts a picked contributor committed as
// (`authors`), as repositoryActivity reads them, kept apart for each.
async function handleRepositoryPulseItems(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams): Promise<void> {
  const repoId = Number(query.get('repoId'))
  const weeks = Number(query.get('weeks') ?? '4')
  const [from, to] = [pulseDay(query.get('from')), query.has('to') ? pulseDay(query.get('to')) : null]
  const logins = (query.get('authors') ?? '').split(',').filter(Boolean)
  // Each once, whatever its case, as GitHub matches logins.
  const authors = [...new Set(logins.map(login => login.toLowerCase()))].toSorted()
  if (!Number.isSafeInteger(repoId) || repoId <= 0 || !PULSE_WEEKS.includes(weeks) || from === null || (query.has('to') && (to === null || to < from))
    || authors.length > PULSE_AUTHORS || !logins.every(login => GITHUB_LOGIN.test(login))) { sendJson(res, 400, { error: 'bad-request' }); return }
  await answerWholeRepository(res, deps, cookie, repoId, async (fullName, token) => {
    const narrowing = { from, to, authors }
    const items = await keptAnswer(deps, `${repoId}\0pulse-items\0${weeks}\0${from}\0${to ?? ''}\0${narrowing.authors.join(',')}`,
      () => repositoryActivity(fullName, token, weeks, Date.now(), globalThis.fetch, narrowing))
    return { value: { weeks, ...items.value }, kept: items.kept }
  })
}

async function pulseCommits(deps: ManagedHttpDeps, repoId: number, fullName: string, token: string) {
  const first = pulseSince(52, Date.now())
  const head = await keptAnswer(deps, `${repoId}\0pulse-head`, async () => ({ sha: await defaultHead(fullName, token) }))
  if (!head.value.sha) return { stats: commitStats([], first), reading: null, pulls: null, pending: false, kept: head.kept }
  const store = repositoryReadStore(deps.db, deps.config.debug)
  const key = `${repoId}\0pulse-year\0${PULSE_YEAR_VERSION}\0${head.value.sha}\0${first}`
  const lastKey = `${repoId}\0pulse-year-last`
  const mergesKey = `${repoId}\0pulse-merges\0${PULSE_YEAR_VERSION}`
  const last = async () => {
    const kept = (await store.read(lastKey))?.value as { first: number; stats: PulseStats } | undefined
    return kept?.first === first ? kept.stats : null
  }
  const sha = head.value.sha
  // What tells whose the year's commits are, kept as read: the agents' pull
  // requests merged (agentMerges), and the commits that release the
  // repository (`releases`, release-commits.ts releaseCommits).
  type Attribution = AgentMerges & { releases?: string[] }
  const keptAttribution = async () => ((await store.read(mergesKey))?.value as Attribution | undefined) ?? null
  const attribution = async (kept: Attribution | null): Promise<Attribution> => {
    const [merges, releases] = await Promise.all([agentMerges(fullName, token, first, kept), releaseCommits(fullName, token, first, historyChanges(deps, repoId))])
    return { ...merges, releases }
  }
  // The year counted from its `commits` as `read` tells whose they are and
  // which were pushed directly, the branch followed through those it was
  // read on past (`passed`, yearCommits) too; kept by its head and as the
  // year last counted.
  const count = async ({ commits, passed }: { commits: HistoryCommit[]; passed: HistoryCommit[] }, read: Attribution) => {
    const walked = [...commits, ...passed]
    const stats = commitStats(commits, first, agentCommits(read, walked), new Set(read.releases), directCommits(read, walked, sha))
    await Promise.all([store.write(key, stats, Date.now()), store.write(lastKey, { first, stats }, Date.now())])
    return stats
  }
  // A year kept by its head, what tells whose its commits are read again as
  // an answer kept is (keptAnswer), a label or a tag changing it without
  // moving the head: counted again from its pages kept where what agents'
  // pull requests bring, or the releases, changed, or a read of the pull
  // requests left unfinished is finished; the year as kept answered
  // meanwhile, and where reading them fails.
  const relabelled = async (stats: PulseStats) => {
    const recounted: { stats?: PulseStats } = {}
    await keptAnswer(deps, mergesKey, async () => {
      const kept = await keptAttribution()
      const read = await attribution(kept)
      const same = kept && !kept.next && sameMerges(read, kept) && read.releases!.join() === (kept.releases ?? []).join()
      if (read.next || same) return read
      const year = await yearCommits(fullName, token, sha, first, historyPages(deps, repoId, true))
      if (year.complete) recounted.stats = await count(year, read)
      return read
    }, () => true).catch((err: unknown) => { console.warn('managed: pulse attribution read failed:', err) })
    return recounted.stats ?? stats
  }
  const held = (await store.read(key))?.value as PulseStats | { tooMany: true } | undefined
  if (held && !('tooMany' in held)) return { stats: await relabelled(held), reading: null, pulls: null, pending: false, kept: head.kept }
  if (!held) {
    const year = await yearCommits(fullName, token, sha, first, historyPages(deps, repoId, true))
    if (year.complete) {
      const read = await attribution(await keptAttribution())
      await store.write(mergesKey, read, Date.now())
      if (read.next) return { stats: await last(), reading: null, pulls: read.next.read, pending: false, kept: false }
      return { stats: await count(year, read), reading: null, pulls: null, pending: false, kept: false }
    }
    if (!year.tooMany) return { stats: await last(), reading: year.read, pulls: null, pending: false, kept: false }
    await store.write(key, { tooMany: true }, Date.now())
  }
  // Its commits and lines read together, kept as one: never the one GitHub
  // has counted since a push beside the other kept from before it.
  const computing = (err: unknown) => err instanceof StatsPending
  const counted = await keptAnswer(deps, `${repoId}\0pulse-stats`, async () => {
    const [stats, lines] = await Promise.all([repositoryStats(fullName, token), repositoryLines(fullName, token, first)])
    return withLines(stats, lines)
  }, computing).catch((err: unknown) => { if (computing(err)) return null; throw err })
  if (counted) return { stats: counted.value, reading: null, pulls: null, pending: false, kept: counted.kept }
  return { stats: await last(), reading: null, pulls: null, pending: true, kept: false }
}

function prebuildBundle(deps: ManagedHttpDeps, id: string) {
  if (!deps.bundleCache || deps.config.serverless) return
  deps.track((async () => {
    const record = await deps.db.getBundle(id)
    if (record?.kind) await deps.bundleCache!.prebuild(record)
  })().catch(err => console.warn('managed: bundle cache build failed:', err)))
}

// Brotli-encoded bytes as they are: the browser's HTTP stack decompresses
// them without a Brotli JS dependency.
async function sendEncoded(req: IncomingMessage, res: ServerResponse, blob: OpenedBlob, contentType: string, headers: Record<string, string> = {}) {
  res.writeHead(200, {
    ...headers, 'content-type': contentType, 'content-encoding': 'br',
    ...(blob.size == null ? {} : { 'content-length': String(blob.size) }), 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') { blob.stream.destroy(); res.end(); return }
  try { await pipeline(blob.stream, res) } catch { res.destroy() }
}


// How often a scan of repositories' risk checks again that its reader is
// still an admin, between the lines it sends; and how long its connection may
// go idle, unread or with no line to send, before the scan is stopped.
const REPO_RISK_RECHECK_MS = 10_000
const REPO_RISK_IDLE_MS = 5 * 60_000
// A scan's part on a serverless deployment, within its function's 300s
// (vercel.managed.json): past it the scan stops, its last line `continue`,
// and the page asks again, from where it stopped (repository-risk.ts).
const REPO_RISK_PART_MS = 270_000

// The repositories a scan of risk reads, by its query: every connected one;
// a team's (`team`, its id), each in the team's directories of it; or one
// (`repo`, its id). Null for a team or repository there is none of, or a
// query naming both.
async function riskRepositories(db: ManagedDb, query: URLSearchParams): Promise<(SelectedRepo & { paths?: string[] })[] | null> {
  const connected = await db.listSelectedRepos()
  const repoId = query.get('repo'), teamId = query.get('team')
  if (teamId !== null && repoId !== null) return null
  if (repoId !== null) {
    const repo = connected.find(item => String(item.repoId) === repoId)
    return repo ? [repo] : null
  }
  if (teamId === null) return connected
  const team = (await db.listTeams()).find(item => item.id === teamId)
  if (!team) return null
  // By repository, its directories; null for the whole of it.
  const paths = new Map<number, string[] | null>()
  for (const { repoId: id, path } of team.repos) {
    const kept = paths.get(id)
    paths.set(id, path === null || kept === null ? null : [...kept ?? [], path])
  }
  return connected.flatMap(repo => {
    const of = paths.get(repo.repoId)
    return of === undefined ? [] : [of === null ? repo : { ...repo, paths: of }]
  })
}

// Where a scan in parts keeps its progress (repository-risk.ts
// ScanProgress) under `key`, for a day; none where the page gave no scan id.
function scanProgress(deps: ManagedHttpDeps, key: string, scan: string | null) {
  if (scan === null || !/^[\w-]{1,64}$/u.test(scan)) return undefined
  const kept = scanReadStore<ScanProgress>(deps.db, 'progress', SCAN_READ_KEPT_MS, deps.config.debug)
  return { read: () => kept.read(key), write: (progress: ScanProgress) => kept.write(key, progress, Date.now()) }
}

// GET /api/admin/repositories/risk: every connected repository's npm
// packages, or a team's or one repository's (riskRepositories), as its
// lockfiles lock them at its default branch's head, each assessed by risk
// (repository-risk.ts), a line as each is found. A
// repository is read with the admin's own GitHub access, as browsing it is
// (repository-browser.ts), and that access checked again once it is read,
// before any of it is told; packages as the npm viewer's admins read them, in
// spare assessments (npm-risk.ts), trusted however new where a team lists
// their scope, and each lockfile's asked of npm's advisories at once; each
// repository's Dependabot alerts, open or dismissed, read with the App's
// installation token where the admin's own access to it lets them see them on
// GitHub (dependabot-access.ts); and its GitHub Actions, the references they
// make resolved with the admin's own GitHub token (github-actions.ts). The
// reader leaving, losing their admin role or
// the server shutting down stops it.
async function handleRepositoryRisk(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, query: URLSearchParams): Promise<void> {
  const s = await readAdminSession(res, deps, cookie, { handed: true })
  if (!s) return
  const repos = await riskRepositories(deps.db, query)
  if (!repos) {
    const both = query.has('team') && query.has('repo')
    sendJson(res, both ? 400 : 404, { error: both ? 'bad-scope' : 'no-repository' })
    return
  }
  const controller = new AbortController()
  res.on('close', () => { controller.abort() })
  res.setTimeout(REPO_RISK_IDLE_MS, () => res.destroy())
  const user = await repositoryBrowserUser(deps, s.user.id)
  const browser = createRepositoryBrowser(deps.config, user)
  const scopes = new Map<string, Promise<boolean>>()
  const teamScoped = (name: string) => {
    const scope = npmPackageScope(name)
    if (scope === null) return Promise.resolve(false)
    if (!scopes.has(scope)) scopes.set(scope, deps.db.hasTeamNpmScope(scope))
    return scopes.get(scope)!
  }
  const versions = npmVersionStore(deps.db, deps.config.debug)
  const stores = { db: deps.db, npmCache: deps.npmCacheStorage, debug: deps.config.debug }
  const lines = repositoryRiskLines({
    // Which repositories a scan in parts told whole, by the admin, the id the
    // page gives the scan (`scan`) and its scope, for the next part to go on
    // past them.
    progress: scanProgress(deps, `${s.user.id}\0${query.get('scan')}\0${query.get('team') ?? ''}\0${query.get('repo') ?? ''}`, query.get('scan')),
    repos: () => Promise.resolve(repos),
    async open(repo) {
      const reader = await browser.reader(repo)
      const commit = await reader.commit('')
      const client = createClient({ token: reader.readToken() })
      return {
        commit,
        lockfiles: async () => (await upstreamGithub(() => client.findRepoLockfiles({ repo: repo.fullName, sha: commit }))).lockfiles,
        file: path => upstreamGithub(() => client.getRepoFile({ repo: repo.fullName, path, ref: commit })),
        recheck: async () => { await reader.recheckAccess() },
        // As GitHub has them now, where the admin's own access lets them see them.
        dependabot: () => reader.dependabotAlerts(),
        workflows: () => reader.directory(WORKFLOWS_DIR, commit).then(({ entries }) => entries.filter(entry => entry.type === 'file' && /\.ya?ml$/iu.test(entry.name)).map(entry => entry.path),
          (error: unknown) => { if (error instanceof GithubApiError && error.status === 404) return []; throw error }),
      }
    },
    actions: githubActionsSource(user.token),
    actionFiles: scanReadStore(deps.db, 'action-files', SCAN_READ_KEPT_MS, deps.config.debug),
    actionLines: scanReadStore(deps.db, 'actions', RISK_KEPT_MS, deps.config.debug),
    teamScoped,
    // Each package's downloads readied before it is assessed
    // (scan-downloads.ts), so that none waits on npm's downloads API; a
    // team's own not asked, as risk asks none of theirs.
    downloads: {
      async atOnce(names, ready, signal) {
        const asked: string[] = []
        for (const name of names) if (await teamScoped(name)) ready(name); else asked.push(name)
        await npmReadyScanDownloads(asked, ready, stores, signal)
      },
      one: (name, signal) => npmReadyScanDownload(name, stores, signal),
    },
    // Public versions' documents kept in the database (npm-kept.ts), as the
    // viewer keeps them: whether npm still has one, its whole document tells
    // risk.
    version: async (name, version, signal) => found(await readNpmVersion(name, version, true, signal, versions)),
    assess: (doc, ownScope, signal) => npmRisk(doc, 'pick', { ...stores, teamScoped: ownScope, privileged: true, signal, spare: true }),
    removed: (name, version, ownScope, signal) => npmRiskRemoved(name, version, { ...stores, teamScoped: ownScope, privileged: true, signal }),
    // Kept for good, a scan telling one past RISK_KEPT_MS at once, as stale.
    risks: riskLineStore(deps.db, Infinity, deps.config.debug),
    // What it read of GitHub kept a day, for a scan answered in parts to go
    // on from where the last stopped, on whichever instance answers the next.
    listings: scanReadStore(deps.db, 'listings', SCAN_READ_KEPT_MS, deps.config.debug),
    lockfiles: scanReadStore(deps.db, 'lockfiles', SCAN_READ_KEPT_MS, deps.config.debug),
    // And each lockfile's advisories, for as long as a scan tells them.
    audits: scanReadStore(deps.db, 'advisories', RISK_KEPT_MS, deps.config.debug),
    // As a bundle's advisories are asked (bundle-advisories.ts), npm's registry
    // and, for packages anyone may read, OSV: no repository's. Each lockfile's
    // audit is bounded on its own, for one npm doesn't answer to fail alone and
    // the scan to carry on.
    async advisories(packages, scanning) {
      const signal = AbortSignal.any([scanning, AbortSignal.timeout(ADVISORIES_TIMEOUT_MS)])
      const audited = await fetchBundleAdvisories(packages.map(pkg => ({ ecosystem: 'npm' as const, ...pkg })), signal,
        { debug: deps.config.debug, cache: auditCache(deps.config.upstreamCacheDir, deps.db, signal, deps.config.debug) })
      if (audited.status !== 200) throw new NpmPackageError(502, audited.body.error)
      return audited.body
    },
  }, controller.signal, undefined, { partMs: deps.config.serverless ? REPO_RISK_PART_MS : null })
  let checked = Date.now()
  await sendLines(res, lines, async () => {
    if (deps.isShuttingDown()) return false
    if (Date.now() - checked < REPO_RISK_RECHECK_MS) return true
    if ((await readSession(deps.config, deps.db, cookie, Date.now()))?.user.role !== 'admin') return false
    checked = Date.now()
    return true
  })
}

// A pretty-printed copy names the file it was formatted from, by the hash it
// was asked for and its source was found to have, for the viewer to check.
const prettySource = ({ hash }: PrettyRequest): Record<string, string> => ({ 'x-source-hash': hash })

// GET /api/bundles/:id/{metadata,contents,pretty}: what `open` reads of the
// bundle, already encoded; it is absent where its cache is.
async function handleBundleCache(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, session: ManagedSession, id: string,
  open: ((rec: ManagedBundle) => Promise<OpenedBlob>) | undefined, contentType = 'application/json', headers: Record<string, string> = {}) {
  const access = await deps.db.getBundleAccessSnapshot(session.id, Date.now(), id)
  if (!access) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  const rec = access.bundle
  if (!rec) { sendJson(res, 404, { error: 'no-bundle' }); return }
  if (!open) { sendJson(res, 503, { error: 'unavailable' }); return }
  let cached
  try { cached = await open(rec) }
  catch (err) { sendJson(res, err instanceof PrettyError ? err.status : 422, { error: err instanceof PrettyError ? err.message : 'bundle-unavailable' }); return }
  // A cold build can outlast a session or membership change.
  const current = await deps.db.getBundleAccessSnapshot(session.id, Date.now(), id)
  if (!current?.bundle) {
    cached.stream.destroy()
    sendJson(res, current ? 404 : 401, { error: current ? 'no-bundle' : 'unauthenticated' })
    return
  }
  await sendEncoded(req, res, cached, contentType, headers)
}

// Two bundles a reader asks about together, where they may read both, else
// null, told as 401 or 404: asked before what is worked out of them and
// again before it is sent.
function bothBundles(res: ServerResponse, deps: ManagedHttpDeps, session: ManagedSession, id: string, otherId: string) {
  return async () => {
    const [base, other] = await Promise.all([id, otherId].map(bundle => deps.db.getBundleAccessSnapshot(session.id, Date.now(), bundle)))
    if (!base || !other) { sendJson(res, 401, { error: 'unauthenticated' }); return null }
    if (!base.bundle || !other.bundle) { sendJson(res, 404, { error: 'no-bundle' }); return null }
    return [base.bundle, other.bundle] as const
  }
}

// GET /api/bundles/:id/rename-diff: one of its JavaScript files diffed with
// one of the `other` bundle's, both pretty-printed, renamed names hidden
// (rename-diff.ts), for a reader of both, checked again once it is worked out.
async function handleBundleRenameDiff(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, session: ManagedSession, id: string, params: URLSearchParams) {
  const otherId = params.get('other') ?? '', request = renameDiffRequest(params)
  if (!request || !/^[a-f\d-]{36}$/iu.test(otherId)) { sendJson(res, 400, { error: 'bad-file' }); return }
  const readable = bothBundles(res, deps, session, id, otherId)
  const records = await readable()
  if (!records) return
  const { prettyCache } = deps
  if (!prettyCache) { sendJson(res, 503, { error: 'unavailable' }); return }
  let diff
  try {
    diff = await renameDiffOf(request, async () => [await prettyText(await prettyCache.bundle(records[0], request.base)),
      await prettyText(await prettyCache.bundle(records[1], request.other))])
  } catch (err) {
    sendJson(res, err instanceof PrettyError ? err.status : 422, { error: err instanceof PrettyError ? err.message : 'bundle-unavailable' }); return
  }
  if (await readable()) await sendEncoded(req, res, diff, 'application/json')
  else diff.stream.destroy()
}

// GET /api/bundles/:id/comparison?other=: its files paired with the `other`
// bundle's as Compare pairs them, with what its Overview reads beside them
// (comparison.ts), within a reason `scope` where given; for a reader of
// both, checked again once it is worked out.
async function handleBundleComparison(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, session: ManagedSession, id: string, params: URLSearchParams) {
  const otherId = params.get('other') ?? ''
  if (!/^[a-f\d-]{36}$/iu.test(otherId)) { sendJson(res, 400, { error: 'bad-bundle' }); return }
  const readable = bothBundles(res, deps, session, id, otherId)
  const records = await readable()
  if (!records) return
  const { prettyCache } = deps
  if (!prettyCache) { sendJson(res, 503, { error: 'unavailable' }); return }
  let body
  try { body = await comparisonBody(await prettyCache.bundleDetails(records[0]), await prettyCache.bundleDetails(records[1]), params.get('scope') ?? '') }
  catch (err) { sendJson(res, err instanceof PrettyError ? err.status : 422, { error: err instanceof PrettyError ? err.message : 'bundle-unavailable' }); return }
  if (await readable()) await sendEncoded(req, res, body, 'application/json')
  else body.stream.destroy()
}

// GET /api/bundles/:id/pretty?other=: the files that changed between it and
// the `other` bundle, both sides' pretty-printed (pretty-print.ts compared), a
// line each as it is found kept or formatted; GET
// /api/bundles/:id/rename-diff?other=, the pairs of them its viewer diffs
// with renamed names hidden (rename-diff.ts renamedPairs), a line each as it
// is worked out; GET /api/bundles/:id/type-only?other=, those that changed in
// types alone (type-only.ts). For a reader of both, checked again before each.
async function handleBundleChanges(res: ServerResponse, deps: ManagedHttpDeps, session: ManagedSession, id: string, otherId: string,
  linesOf: (cache: PrettyCache, base: ManagedBundle, other: ManagedBundle) => Promise<AsyncIterable<unknown>>) {
  if (!/^[a-f\d-]{36}$/iu.test(otherId)) { sendJson(res, 400, { error: 'bad-bundle' }); return }
  const access = () => Promise.all([id, otherId].map(bundle => deps.db.getBundleAccessSnapshot(session.id, Date.now(), bundle)))
  const [base, other] = await access()
  if (!base || !other) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!base.bundle || !other.bundle) { sendJson(res, 404, { error: 'no-bundle' }); return }
  if (!deps.prettyCache) { sendJson(res, 503, { error: 'unavailable' }); return }
  let lines
  try { lines = await linesOf(deps.prettyCache, base.bundle, other.bundle) }
  catch (err) { sendJson(res, err instanceof PrettyError ? err.status : 422, { error: err instanceof PrettyError ? err.message : 'bundle-unavailable' }); return }
  await sendLines(res, lines, async () => (await access()).every(snapshot => snapshot?.bundle))
}

// Published dependency advisories require security access, independently of access to
// unpublished dependency findings. Managers retain their normal bundle access.
async function handleBundleAdvisories(res: ServerResponse, deps: ManagedHttpDeps, session: ManagedSession, id: string, teamId: string | null, reason: string, repoAdvisories: boolean, details: boolean) {
  const authorize = async () => {
    const access = await deps.db.getBundleAccessSnapshot(session.id, Date.now(), id, teamId)
    if (!access) { sendJson(res, 401, { error: 'unauthenticated' }); return null }
    if (!access.bundle) { sendJson(res, 404, { error: 'no-bundle' }); return null }
    if (!access.canReadAdvisories) {
      sendJson(res, 403, { error: 'security-access-required' }); return null
    }
    return access.bundle
  }
  const record = await authorize()
  if (!record) return
  if (record.kind !== 'stasis') { sendJson(res, 422, { error: 'unsupported-bundle' }); return }
  if (!deps.bundleCache) { sendJson(res, 503, { error: 'unavailable' }); return }
  let inventory: BundleAdvisoryInventory | null | undefined
  try { inventory = await deps.bundleCache.advisoryInventory(record, reason) }
  catch { sendJson(res, 422, { error: 'bundle-unavailable' }); return }
  if (!(await authorize())) return
  if (inventory === null) { sendJson(res, 413, { error: 'payload-too-large' }); return }
  if (inventory === undefined) { sendJson(res, 400, { error: 'unknown-reason' }); return }
  if (Buffer.byteLength(JSON.stringify(inventory)) > MAX_PACKAGE_INVENTORY_BYTES) { sendJson(res, 413, { error: 'payload-too-large' }); return }
  const controller = new AbortController()
  const onClose = () => { if (!res.writableEnded) controller.abort() }
  res.on('close', onClose)
  // Its deadline aborts as AbortSignal.timeout does, for a failure it leaves to be told from the reader's leaving.
  const timer = setTimeout(() => controller.abort(new DOMException('advisories took too long', 'TimeoutError')), ADVISORIES_TIMEOUT_MS)
  try {
    if (res.destroyed) return
    const needsGithub = inventory.packages.some(pkg => repoAdvisories || pkg.ecosystem === 'github' || pkg.ecosystem === 'soldeer')
    const githubToken = needsGithub ? await ensureUserAccessToken(deps.config, deps.db, session.userId, Date.now(), (url, init) => fetch(url, {
      ...init, signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
    })) : null
    if (res.destroyed || (needsGithub && !(await authorize()))) return
    const result = await fetchBundleAdvisories(inventory.packages, controller.signal, {
      debug: deps.config.debug, repoAdvisories, details, githubToken,
      cache: auditCache(deps.config.upstreamCacheDir, deps.db, controller.signal, deps.config.debug, auditedRepos(inventory.packages, repoAdvisories)),
    })
    if (res.destroyed || !(await authorize())) return
    // Return just inventory and public advisories, never source or report data.
    sendJson(res, result.status, result.status === 200 ? { ...inventory, advisories: result.body } : result.body)
  } finally {
    clearTimeout(timer)
    res.off('close', onClose)
  }
}

// GET /api/admin/bundles — the uploaded bundles for the "Manage bundles" page.
// admin|manage, read-only (no CSRF). `maxBytes` is the upload cap; `repos` feeds
// the upload repo picker.
async function handleListBundles(res: ServerResponse, deps: ManagedHttpDeps, session: ManagedSession): Promise<void> {
  const before = await deps.db.getBundleCatalog(session.id, Date.now())
  const summaries = await bundleSummaries(before.bundles, deps.bundleCache)
  const commits = await bundleCommits(deps.db, before.bundles, summaries)
  // Even cached storage and commit reads may outlast changes to access or locations.
  const catalog = await deps.db.getBundleCatalog(session.id, Date.now())
  sendJson(res, 200, {
    ...catalog,
    bundles: catalog.bundles.map(bundle => ({
      ...bundle, ...(summaries.get(bundle.integrity) ?? { summary: null, summaryRetryAt: null }), commitInfo: commits.commitInfo(bundle),
    })),
    maxBytes: deps.config.maxBundleBytes,
  })
  await backfillBundleSummaries(catalog.bundles, deps.bundleCache)
  await backfillCatalogCommits(deps, session.userId, commits.missing)
}

type UploadedBundle = Pick<ManagedBundle, 'id' | 'slug' | 'integrity' | 'filename' | 'byteSize' | 'repoId' | 'repoDirectory'>
// `reuse` describes a repeated upload/build of an existing row (see reuseBundle).
async function sendUploadedBundle(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined,
  bundle: UploadedBundle, reuse?: Omit<BundleReuse, 'rename'>): Promise<void> {
  const s = await manageMutation(req, res, deps, cookie)
  if (!s) return
  const deduped = reuse != null
  if (deduped) {
    // Authorized in the same transaction as the rename. A server build labels
    // even a row the caller cannot see: the bytes are this server's own output.
    if (await deps.db.reuseBundleUpload(s.session.id, bundle.id, reuse)) bundle = await deps.db.getBundle(bundle.id) ?? bundle
    if (!(await canAccessBundle(deps, s.user, bundle.id))) { sendJson(res, 409, { error: 'bundle-conflict' }); return }
  }
  const { id, slug, integrity, filename, byteSize, repoId, repoDirectory } = bundle
  // Re-uploading also repairs reports uploaded while the bundle was inaccessible.
  await deps.db.linkReportsToBundle(integrity, id, s.user.role === 'admin' ? undefined : s.user.id)
  prebuildBundle(deps, id)
  sendJson(res, deduped ? 200 : 201, { id, slug, integrity, filename, repoId, repoDirectory, ...(deduped ? { deduped: true } : { byteSize }) })
}

async function handleCreateBundle(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const initial = await manageMutation(req, res, deps, cookie, { handed: true })
  if (!initial) return
  const controller = new AbortController()
  const onClose = () => controller.abort()
  res.on('close', onClose)
  try {
    let body: unknown
    try { body = await readJsonBody(req, 128 * 1024) } catch { throw new BundleBuildError(400, 'bad-body') }
    const input = parseBundleBuild(body)
    const authorize = async (directory: string) => {
      const session = await manageMutation(req, res, deps, cookie)
      if (!session) return null
      const repo = (await bundleRepos(deps, session.user)).find(item => item.repoId === input.repoId)
      if (!repo) throw new BundleBuildError(404, 'no-repository')
      const scopes = session.user.role === 'admin' ? [null]
        : (await deps.db.listRepoScopesForUser(session.user.id)).filter(scope => scope.repoId === input.repoId).map(scope => scope.path)
      if (scopedDirectory(directory, scopes) !== null) throw new BundleBuildError(403, 'build-scope')
      return { ...session, repo, scopes }
    }
    const access = await authorize(input.directory)
    if (!access) return
    await withBundleBuildLease(deps.db, access.user.id, controller.signal, async signal => {
      const reader = await createRepositoryBrowser(deps.config, await repositoryBrowserUser(deps, access.user.id)).reader(access.repo)
      signal.throwIfAborted()
      // Catalogs then show the built bundle's commit details from the cache.
      const commitCached = cacheCommitDetails(deps.db, reader, input.repoId, input.commit)
      const built = await buildRepositoryBundle(access.user.id, {
        input, github: access.repo.fullName, token: reader.readToken(), maxBytes: deps.config.maxBundleBytes, scopes: access.scopes,
        cacheDir: deps.config.upstreamCacheDir ?? null,
      }, signal)
      await commitCached
      signal.throwIfAborted()
      await reader.recheckAccess()
      const current = await authorize(built.directory)
      if (!current) return
      if (JSON.stringify({ ...current.repo, cachedDefaultBranch: access.repo.cachedDefaultBranch }) !== JSON.stringify(access.repo)) {
        throw new BundleBuildError(409, 'repository-changed')
      }
      signal.throwIfAborted()
      await storeUploadedBundle(req, res, deps, cookie, current, built.bytes, input.repoId, built.directory, built.filename, 'build',
        bundleIntegrity(built.bytes), input.conditions)
    })
  } catch (error) {
    if (res.destroyed || controller.signal.aborted) return
    if (error instanceof BundleBuildError) { sendJson(res, error.status, { error: error.code }); return }
    if (error instanceof GithubApiError) {
      sendJson(res, error.status === 401 ? 502 : error.status, { error: error.message }, error.retryAfter == null ? {} : { 'retry-after': String(error.retryAfter) })
      return
    }
    throw error
  } finally { res.off('close', onClose) }
}

// POST /api/admin/bundles — upload a bundle. Mutation: same-origin + CSRF,
// admin|manage. Raw bytes; X-Bundle-Filename names it, optional X-Repo-Id and
// X-Repo-Directory assign a repository location; Stasis repo headers default
// to a matching connected repository within the uploader's access, otherwise
// the bundle stays unattached. Its identity is its content hash (sha512), UNIQUE — a
// re-upload of identical bytes dedupes to the existing row (no second copy) and
// renames it, unless the row was built on this server.
// After storing, any reports that declared this integrity but weren't linked yet
// get attached (auto-link). 413 over the cap, 400 on empty.
async function handleUploadBundle(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  let s = await checkMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  if (!requireManageRole(res, s.user)) return
  let bytes: Buffer
  try {
    bytes = await readUploadBody(req, deps, s.session, 'bundles')
  } catch (err) {
    const tooLarge = err instanceof Error && err.message === 'too-large'
    sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'too-large' : 'bad-body' })
    return
  }
  // Shared storage reads may outlast a session or role change.
  s = await checkMutation(req, res, deps, cookie)
  if (!s || !requireManageRole(res, s.user)) return
  if (bytes.length === 0) { sendJson(res, 400, { error: 'empty' }); return }
  const repo = await resolveUploadRepoId(req, res, deps)
  if (!repo.ok) return
  const filename = sanitizeFilename(firstHeader(req.headers['x-bundle-filename']), 'bundle')
  const kind = bundleKind(filename)
  // Explicit locations override embedded defaults. Reuploads keep their
  // stored location, so only new bundles need their origin header decoded.
  const integrity = bundleIntegrity(bytes)
  const existing = await deps.db.getBundleByIntegrity(integrity)
  let inferredLocation = false
  let rawDirectory: unknown
  try { rawDirectory = decodeURIComponent(firstHeader(req.headers['x-repo-directory']) ?? '') }
  catch { sendJson(res, 400, { error: 'bad-directory' }); return }
  if (!existing && repo.repoId == null && kind === 'stasis') {
    const embedded = await bundleRepo(bytes)
    const github = reportRepoGithub({ repo: embedded })
    const embeddedDirectory = normalizeTeamPath(embedded?.directory)
    // Invalid optional metadata must not reject an otherwise unattached bundle.
    // Only repository-wide aliases/direct connections can resolve without a
    // valid directory; do not decode file paths or match directory aliases.
    const location = github == null ? null : embeddedDirectory.ok
      ? await resolveRepositoryImportLocation(deps.db, github, embeddedDirectory.path ?? '', () => bundleFilePrefix(bytes))
      : await deps.db.getRepositoryImportLocation(github, '')
    if (location?.repoId != null) {
      repo.repoId = location.repoId
      if (req.headers['x-repo-directory'] == null) {
        if (!embeddedDirectory.ok) { sendJson(res, 400, { error: 'bad-directory' }); return }
        rawDirectory = location.directory
        inferredLocation = true
      }
    }
    s = await checkMutation(req, res, deps, cookie)
    if (!s || !requireManageRole(res, s.user)) return
  }
  const normalized = normalizeTeamPath(rawDirectory)
  if (!normalized.ok) { sendJson(res, 400, { error: 'bad-directory' }); return }
  let directory = repo.repoId == null ? '' : normalized.path ?? ''
  if (repo.repoId !== null && s.user.role !== 'admin' && !(await deps.db.userCanReadRepoPath(s.user.id, repo.repoId, directory))) {
    if (!inferredLocation) { sendJson(res, 403, { error: 'forbidden' }); return }
    // A bundle's own stamp is a default, not a required destination. Retain
    // it in the archive while letting the uploader assign an allowed location.
    repo.repoId = null
    directory = ''
  }
  await storeUploadedBundle(req, res, deps, cookie, s, bytes, repo.repoId, directory, filename, 'upload', integrity, null, existing === null)
}

// `absent` where the caller has just found no bundle of `integrity`: not read
// again, one inserted since meeting the insert's UNIQUE below as a race does.
async function storeUploadedBundle(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined,
  s: { session: ManagedSession; user: StoredUser }, bytes: Buffer, repoId: number | null, directory: string, filename: string,
  provenance: BundleProvenance, integrity = bundleIntegrity(bytes), buildConditions: BundleBuildConditions | null = null, absent = false): Promise<void> {
  const kind = bundleKind(filename)
  const reuse = { provenance, filename, kind, buildConditions }
  const existing = absent ? null : await deps.db.getBundleByIntegrity(integrity)
  if (existing) { await sendUploadedBundle(req, res, deps, cookie, existing, reuse); return }
  const id = randomUUID()
  const dataKey = await deps.bundleStore.put(id, bytes, kind)
  try {
    await deps.db.insertBundle({
      id, integrity, filename, kind, dataKey, provenance, buildConditions,
      byteSize: bytes.length, uploadedBy: s.user.id, uploadedByLogin: s.user.login, repoId, repoDirectory: directory,
    }, Date.now(), s.session.id)
  } catch (err) {
    // A concurrent upload of identical bytes can insert this integrity (UNIQUE)
    // between our dedup check and this insert — treat that as a dedup, not a 500.
    // Any other failure rethrows.
    let raced: ManagedBundle | null
    try { raced = await deps.db.resolveBundleUpload(integrity) }
    catch (lookup) { throw new AggregateError([err, lookup], 'Bundle upload reconciliation failed', { cause: lookup }) }
    // Preserve a committed candidate after a lost acknowledgement. If this
    // read fails too, leave the bytes for later reconciliation.
    if (raced?.id !== id) await deps.bundleStore.delete(id).catch(() => {})
    if (err instanceof ManagedMutationError) throw err
    if (!raced) throw err
    if (raced.id !== id) { await sendUploadedBundle(req, res, deps, cookie, raced, reuse); return }
    // Our insert committed: continue with the ordinary creation response.
  }
  const stored = await deps.db.getBundle(id)
  if (!stored) { sendJson(res, 404, { error: 'no-bundle' }); return }
  await sendUploadedBundle(req, res, deps, cookie, stored)
}

// GET /api/admin/bundles/<id> — download a stored bundle (admin|manage). Bytes
// are opaque archives, so served as application/octet-stream. Sourcemaps use
// HTTP Brotli decoding to restore the uploaded .map bytes. 404 no such
// bundle; 503 row-without-bytes (store desync).
async function handleGetBundle(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, session: ManagedSession, id: string): Promise<void> {
  const access = await deps.db.getBundleAccessSnapshot(session.id, Date.now(), id)
  if (!access) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  const rec = access.bundle
  if (rec == null) { sendJson(res, 404, { error: 'no-bundle' }); return }
  const stored = await deps.bundleStore.open(id, rec.kind)
  if (stored == null) { sendJson(res, 503, { error: 'unavailable' }); return }
  const current = await deps.db.getBundleAccessSnapshot(session.id, Date.now(), id)
  if (!current?.bundle) {
    stored.stream.destroy()
    sendJson(res, current ? 404 : 401, { error: 'no-bundle' }); return
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    ...(rec.kind === 'sourcemap' ? { 'content-encoding': 'br' } : {}),
    ...(stored.size == null ? {} : { 'content-length': String(stored.size) }),
    'content-disposition': attachmentDisposition(rec.filename),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  })
  if (req.method === 'HEAD') { stored.stream.destroy(); res.end(); return }
  try { await pipeline(stored.stream, res) } catch { res.destroy() }
}

// DELETE /api/admin/bundles/<id> — remove a bundle (admin|manage). Mutation:
// same-origin + CSRF. Drops the row (referencing reports' bundle_id null out via
// the FK; their bundle_integrity stays, so a re-upload re-links), then the bytes
// best-effort. 404 when there was no such bundle.
async function handleDeleteBundle(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await checkMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  if (!requireManageRole(res, s.user)) return
  const { bundle, user } = await deps.db.mutateBundle(s.session.id, id, { type: 'delete' })
  await deps.bundleCache?.delete(id).catch((err) => { console.warn('managed: bundle cache delete failed:', err) })
  await deps.reportSourcesCache?.deleteBundle(id).catch((err) => { console.warn('managed: report sources delete failed:', err) })
  await deps.bundleStore.delete(id).catch((err) => { console.warn('managed: bundle bytes delete failed:', err) })
  await activity(deps, user, 'delete', 'deleted a bundle', { repoId: bundle.repoId, repoDirectory: bundle.repoDirectory, bundleId: id, report: bundle.filename, repo: await repositoryName(deps, bundle.repoId) })
  sendJson(res, 200, { ok: true })
}

// admin|manage mutation guard: same-origin + CSRF + role, in one step. Returns
// the session, or null after the 401/403 was sent.
async function manageMutation(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, { handed = false } = {}): Promise<{ session: ManagedSession; user: StoredUser } | null> {
  const s = await checkMutation(req, res, deps, cookie, { handed })
  if (s == null) return null
  if (!requireManageRole(res, s.user)) return null
  return s
}

// Workspace access and repository connections are administered separately
// from content management. Managers cannot change their own access via teams.
async function adminMutation(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, { handed = false } = {}): Promise<{ session: ManagedSession; user: StoredUser } | null> {
  const s = await checkMutation(req, res, deps, cookie, { handed })
  if (s == null) return null
  if (s.user.role !== 'admin') { sendJson(res, 403, { error: 'forbidden' }); return null }
  return s
}

// GET /api/teams — the CURRENT user's teams, each with the reports and bundles
// attached to the team's repos, for the sidebar's per-user Teams section. Any approved
// user (not just admin|manage); a user only ever sees their own teams.
// Each team carries `app`, its App classification (team-app.ts), so the
// sidebar's first paint already shows App teams collapsed.
async function handleMyTeams(res: ServerResponse, deps: ManagedHttpDeps, session: ManagedSession): Promise<void> {
  let snapshot = await deps.db.getUserTeamFeedSnapshot(session.id, Date.now())
  if (!snapshot) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  const [summaries, classified] = await Promise.all([
    bundleSummaries(snapshot.teams.flatMap(team => team.bundles), deps.bundleCache),
    teamAppStates(deps.db, deps.reportStore, session.id, snapshot.teams),
  ])
  const commits = await bundleCommits(deps.db, snapshot.teams.flatMap(team => team.bundles), summaries)
  const current = await deps.db.getFeedState(session.id, Date.now())
  if (!current) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  // Keep the post-storage authorization fence, but reload the catalog only
  // when a concurrent mutation actually invalidated its consistent snapshot.
  if (current.user.id !== snapshot.user.id || current.user.role !== snapshot.user.role || current.catalog !== snapshot.catalog) {
    snapshot = await deps.db.getUserTeamFeedSnapshot(session.id, Date.now())
    if (!snapshot) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  }
  const { teams, revision } = snapshot
  // The revision sent is the reloaded catalog's, so classify what changed now.
  const apps = await teamAppStates(deps.db, deps.reportStore, session.id, teams, classified)
  sendJson(res, 200, {
    teams: teams.map(team => ({ ...withWorkspaceSummary(team, apps.get(teamAppKey(team))),
      bundles: team.bundles.map(bundle => ({ ...bundle, ...(summaries.get(bundle.integrity) ?? { summary: null, summaryRetryAt: null }),
        commitInfo: commits.commitInfo(bundle) })) })),
    revision,
  })
  await backfillBundleSummaries(teams.flatMap(team => team.bundles), deps.bundleCache)
  await backfillCatalogCommits(deps, session.userId, commits.missing)
}

// Admins read all reports. Managers read their uploads or reports inside their
// team repository paths, including drafts they may manage. View/triage users
// need a published report in their teams; ownership never overrides role none.
async function canViewReport(deps: ManagedHttpDeps, user: StoredUser, reportId: string): Promise<boolean> {
  if (!roleAtLeast(user.role, 'view')) return false
  const report = await deps.db.getReportView(user.id, reportId)
  if (report == null) return false
  if (user.role === 'admin') return true
  if (user.role === 'manage') return report.uploadedBy === user.id || report.readable
  return report.visible && report.readable
}

// GET/HEAD /api/reports/:id/sources. Only the linked bundle's files cited by
// visible findings (location AND evidence) are returned. Missing/unavailable
// bundles are a quiet no-op; cached gzip bodies stream directly from disk.
async function handleReportSources(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string, teamId: string | null) {
  const s = await readSession(deps.config, deps.db, cookie, Date.now(), { handed: true })
  if (!s) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!(await canViewReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  const sourcePaths = roleAtLeast(s.user.role, 'manage') ? undefined : await teamSourcePaths(deps.db, deps.reportStore, s.session.id, teamId ?? '', id)
  const report = await deps.db.getReport(id)
  const bundle = report?.bundleId ? await deps.db.getBundle(report.bundleId) : null
  const empty = () => { res.writeHead(204, { 'cache-control': 'private, no-store' }); res.end() }
  if (!report || !bundle || !['stasis', 'sourcemap'].includes(bundle.kind ?? '') || !(await canAccessBundle(deps, s.user, bundle.id))) { empty(); return }
  if (!deps.reportSourcesCache) { sendJson(res, 503, { error: 'unavailable' }); return }
  let cached
  try { cached = await deps.reportSourcesCache.open(report, bundle, { dependencies: true, security: true }, sourcePaths) }
  catch { empty(); return }
  if (!cached) { empty(); return }
  // Cold parsing can outlast role/team changes, report deletion, or relinking.
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  const latest = await deps.db.getReport(id)
  let latestPaths: Set<string> | undefined
  try { latestPaths = current && !roleAtLeast(current.user.role, 'manage') ? await teamSourcePaths(deps.db, deps.reportStore, current.session.id, teamId ?? '', id) : undefined }
  catch (error) { cached.stream.destroy(); throw error }
  if (!current || current.user.role !== s.user.role || sourcePaths?.size !== latestPaths?.size || [...sourcePaths ?? []].some(path => !latestPaths?.has(path)) || !(await canViewReport(deps, current.user, id)) || !(await canAccessBundle(deps, current.user, bundle.id))
      || latest?.bundleId !== bundle.id || latest.sha256 !== report.sha256
      || latest.repoId !== report.repoId || await repositoryName(deps, latest.repoId) !== cached.repo.github) {
    cached.stream.destroy()
    sendJson(res, current ? 404 : 401, { error: current ? 'no-report' : 'unauthenticated' })
    return
  }
  res.writeHead(200, {
    'content-type': 'application/json', 'content-encoding': 'gzip',
    ...(cached.size == null ? {} : { 'content-length': String(cached.size) }), 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') { cached.stream.destroy(); res.end(); return }
  try { await pipeline(cached.stream, res) } catch { res.destroy() }
}

async function reportIds(data: unknown): Promise<Set<string>> {
  const findings = (reportEntries(data) ?? []).flat().filter((f): f is Record<string, unknown> => f !== null && typeof f === 'object' && !Array.isArray(f))
  await backfillFindingIds(findings)
  return new Set(findings.flatMap(f => typeof f['id'] === 'string' ? [f['id']] : []))
}

async function handleDeduplication(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id?: string): Promise<void> {
  const method = req.method ?? 'GET'
  if (!(id ? ['GET', 'PATCH'] : ['GET', 'POST']).includes(method)) { send405(res, id ? 'GET, PATCH' : 'GET, POST'); return }
  const s = method === 'GET' ? await readSession(deps.config, deps.db, cookie, Date.now(), { handed: true }) : await checkMutation(req, res, deps, cookie, { handed: true })
  if (!s) { if (method === 'GET') sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (s.user.role !== 'admin') { sendJson(res, 403, { error: 'forbidden' }); return }
  if (method === 'GET') { sendJson(res, 200, id ? await deps.db.getLinkReport(s.session.id, id) : { reports: await deps.db.listLinkReports() }); return }
  if (id) {
    let body
    try { body = await readJsonBody(req, 1024) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
    const enabled = (body as { enabled?: unknown } | null)?.enabled
    if (typeof enabled !== 'boolean') { sendJson(res, 400, { error: 'bad-enabled' }); return }
    await deps.db.setLinkReportEnabled(s.session.id, id, enabled)
    sendJson(res, 200, { ok: true }); return
  }
  let bytes: Buffer
  try { bytes = await readUploadBody(req, deps, s.session, 'links') }
  catch (error) { const large = error instanceof Error && error.message === 'too-large'; sendJson(res, large ? 413 : 400, { error: large ? 'too-large' : 'bad-body' }); return }
  const filename = sanitizeFilename(firstHeader(req.headers['x-report-filename']), 'report.link.json')
  const result = await deps.db.importLinkReport(s.session.id, filename, bytes.toString('utf8'))
  sendJson(res, result.reused ? 200 : 201, { ...result.report, deduped: result.reused })
}

async function handleRepositoryAliases(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id?: string): Promise<void> {
  const method = req.method ?? 'GET'
  if (!(id ? ['PATCH', 'DELETE'] : ['GET', 'POST']).includes(method)) { send405(res, id ? 'PATCH, DELETE' : 'GET, POST'); return }
  const s = method === 'GET' ? await readAdminSession(res, deps, cookie, { handed: true }) : await checkMutation(req, res, deps, cookie, { handed: true })
  if (!s) return
  if (s.user.role !== 'admin') { sendJson(res, 403, { error: 'forbidden' }); return }
  if (method === 'GET') {
    sendJson(res, 200, { aliases: await deps.db.listRepositoryAliases(), repos: await deps.db.listAllRepos() }); return
  }
  if (method === 'DELETE') {
    await deps.db.deleteRepositoryAlias(s.session.id, id!)
    sendJson(res, 200, { ok: true }); return
  }
  let body
  try { body = await readJsonBody(req, 8192) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const alias = await deps.db.saveRepositoryAlias(s.session.id, id ?? null, body)
  sendJson(res, id ? 200 : 201, alias)
}

// Live suggestions do not mutate archived content or its stored assignment.
// Managers can resolve only destinations their current repository grants cover.
async function handleRepositorySuggestion(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  if (req.method !== 'GET') { send405(res, 'GET'); return }
  if (!await readManageSession(res, deps, cookie, { handed: true })) return
  const params = new URL(req.url!, 'http://localhost').searchParams
  const github = reportRepoGithub({ repo: { github: params.get('repo') } })
  const directory = normalizeTeamPath(params.get('directory'))
  const filePrefix = normalizeTeamPath(params.get('filePrefix'))
  if (!github || !directory.ok || !filePrefix.ok) { sendJson(res, 400, { error: 'bad-location' }); return }
  const location = await deps.db.getRepositoryImportLocation(github, directory.path ?? '', filePrefix.path ?? '')
  const repo = location.repoId == null ? null : (await deps.db.listSelectedRepos()).find(row => row.repoId === location.repoId)
  const s = await readManageSession(res, deps, cookie)
  if (!s) return
  const allowed = repo && (s.user.role === 'admin' || await deps.db.userCanReadRepoPath(s.user.id, repo.repoId, location.directory))
  sendJson(res, 200, { location: allowed ? { repoId: repo.repoId, github: repo.fullName, directory: location.directory,
    mapped: github.toLowerCase() !== repo.fullName.toLowerCase() || (directory.path ?? '') !== location.directory } : null })
}

// Where a report without an embedded repository suggests it belongs, resolved
// through current connections and aliases like bundle metadata. `repoId` is
// set only for an active destination within the user's grants; the named
// repository itself is part of the report. `directory` is null when neither
// the report nor an alias specifies one.
async function suggestReportLocation(deps: ManagedHttpDeps, user: StoredUser, data: { repo?: { directory?: unknown } } | null | undefined) {
  const github = findingsRepository(data)
  if (github == null) return null
  // An invalid optional directory is ignored, as for bundle metadata.
  const declared = normalizeTeamPath(data?.repo?.directory)
  const directory = declared.ok ? declared.path : null
  const location = await deps.db.getRepositoryImportLocation(github, directory ?? '', ownFileDirectory(data))
  const repo = location.repoId == null ? null : (await deps.db.listSelectedRepos()).find(row => row.repoId === location.repoId)
  const allowed = repo && (user.role === 'admin' || await deps.db.userCanReadRepoPath(user.id, repo.repoId, location.directory))
  if (!allowed) return { repoId: null, github, directory }
  const mapped = github.toLowerCase() !== repo.fullName.toLowerCase() || (directory ?? '') !== location.directory
  return { repoId: repo.repoId, github: repo.fullName, directory: mapped ? location.directory : directory }
}

// GET /api/admin/reports/<id>/location — the live suggestion for a report's
// location editor. It never changes the stored assignment.
async function handleReportLocationSuggestion(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  if (req.method !== 'GET') { send405(res, 'GET'); return }
  const s = await readManageSession(res, deps, cookie, { handed: true })
  if (!s) return
  const report = await deps.db.getReport(id)
  if (!report || !(await canViewReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  if (report.repoEmbedded) { sendJson(res, 200, { location: null }); return }
  const bytes = await deps.reportStore.get(id)
  if (bytes == null) { sendJson(res, 503, { error: 'unavailable' }); return }
  const { data } = readManagedReport(bytes.toString('utf8'), report.filename)
  // Storage reads can outlast a session, role or grant change.
  const current = await readManageSession(res, deps, cookie)
  if (!current) return
  if (!(await canViewReport(deps, current.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  sendJson(res, 200, { location: await suggestReportLocation(deps, current.user, data) })
}

// GET /api/reports/<id> — admin/manager preview, within management access.
// Accept: application/json includes parsed, filtered data and the server's repo
// assignment. Other callers retain the raw text/plain response. The
// client renders either without caching to OPFS. 404 covers "no such report" AND
// "not authorized" (so neither existence nor membership is probeable); 503 = row
// without bytes (store desync).
async function handleViewReport(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await readManageSession(res, deps, cookie, { handed: true })
  if (s == null) return
  const snapshot = await deps.db.getReportAccessSnapshot(s.session.id, Date.now(), [id])
  const access = snapshot?.reports[0]
  if (!snapshot || !access || !roleAtLeast(snapshot.user.role, 'manage')) { sendJson(res, 404, { error: 'no-report' }); return }
  const bytes = await deps.reportStore.get(id)
  if (bytes == null) { sendJson(res, 503, { error: 'unavailable' }); return }
  const metadata = acceptsReportMetadata(req.headers.accept)
  let envelope
  if (metadata) {
    const { data } = readManagedReport(bytes.toString('utf8'), access.filename)
    if (data == null) { sendJson(res, 422, { error: 'unreadable-report' }); return }
    const links = mergeLinkGroups(snapshot.linkRevision ? await deps.db.getEnabledLinkGroups(snapshot.linkRevision) : [], await reportIds(data))
    envelope = { data, repo: access.repo, ...(links.length > 0 ? { links } : {}) }
  }
  // Link decryption and finding-ID backfill can outlast access or link changes.
  const current = await deps.db.getReportAccessSnapshot(s.session.id, Date.now(), [id])
  if (!current || current.user.id !== snapshot.user.id || current.user.role !== snapshot.user.role
    || current.linkRevision !== snapshot.linkRevision || JSON.stringify(current.reports) !== JSON.stringify(snapshot.reports)) {
    sendJson(res, 404, { error: 'no-report' }); return
  }
  if (metadata) {
    sendJson(res, 200, envelope, { vary: 'Accept', 'x-content-type-options': 'nosniff' }); return
  }
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8', 'content-length': String(bytes.length),
    'x-content-type-options': 'nosniff', 'cache-control': 'no-store', vary: 'Accept',
  })
  writeResponse(res, bytes)
}

// A read-only POST avoids URL-length limits when a workspace has many reports.
// Authorize every requested id before reading blobs; never return a partial
// workspace, or let one authorized report grant access to another in the batch.
const REPORT_QUERY_CONCURRENCY = 8
const REPORT_QUERY_IN_FLIGHT_BYTES = 64 * 1024 * 1024
async function handleQueryReports(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readManageSession(res, deps, cookie, { handed: true })
  if (!s) return
  let body
  try { body = await readJsonBody(req, 1024 * 1024) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const raw = (body as { ids?: unknown } | null)?.ids
  if (!Array.isArray(raw) || raw.some(id => typeof id !== 'string' || !id || id.length > 256)) {
    sendJson(res, 400, { error: 'bad-ids' }); return
  }
  const ids = [...new Set(raw as string[])]
  if (ids.length > MAX_REPORT_QUERY_COUNT) { sendJson(res, 413, { error: 'batch-too-large' }); return }
  const snapshot = await deps.db.getReportAccessSnapshot(s.session.id, Date.now(), ids)
  if (!snapshot || snapshot.user.id !== s.user.id) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!roleAtLeast(snapshot.user.role, 'manage')) { sendJson(res, 404, { error: 'no-report' }); return }
  const reports = new Map(snapshot.reports.map(report => [report.id, report]))
  if (reports.size !== ids.length) { sendJson(res, 404, { error: 'no-report' }); return }
  const storedBytes = snapshot.reports.reduce((total, report) => total + report.byteSize, 0)
  if (storedBytes > MAX_REPORT_QUERY_BYTES) { sendJson(res, 413, { error: 'batch-too-large' }); return }
  // Overlap remote blob reads, retaining only each report's encoded response
  // after processing. Check actual bytes too if storage and metadata disagree.
  const parts = [Buffer.from('{"reports":[')]
  const findingIds = new Set<string>()
  let inputBytes = 0, outputBytes = parts[0]!.length + 2
  let next = 0, stopped = false
  let inFlightBytes = 0
  let capacity = Promise.withResolvers<void>()
  const fail = (status: number, error: string) => { stopped = true; return { status, error } }
  const workers = await Promise.allSettled(Array.from({ length: Math.min(REPORT_QUERY_CONCURRENCY, ids.length) }, async () => {
    try {
      while (next < ids.length) {
        if (stopped) return
        const index = next
        const id = ids[index]!
        const access = reports.get(id)!
        const reservedBytes = Math.max(1, access.byteSize)
        // Reserve stored bytes before starting remote reads, through encoding.
        // A report larger than the concurrent budget is still allowed alone.
        if (inFlightBytes > 0 && inFlightBytes + reservedBytes > REPORT_QUERY_IN_FLIGHT_BYTES) {
          await capacity.promise
          continue
        }
        next++
        inFlightBytes += reservedBytes
        try {
          const bytes = await deps.reportStore.get(id)
          if (stopped) return
          if (bytes == null) return fail(503, 'unavailable')
          inputBytes += bytes.length
          if (inputBytes > MAX_REPORT_QUERY_BYTES) return fail(413, 'batch-too-large')
          const { data } = readManagedReport(bytes.toString('utf8'), access.filename)
          if (!data) return fail(422, 'unreadable-report')
          for (const findingId of await reportIds(data)) findingIds.add(findingId)
          const part = Buffer.from(`${index > 0 ? ',' : ''}${JSON.stringify({ id, data: filterReportData(data, access.permissions, access.repo), repo: access.repo })}`)
          outputBytes += part.length
          if (outputBytes > MAX_REPORT_QUERY_BYTES) return fail(413, 'batch-too-large')
          // Completion order may differ from the requested report order.
          parts[index + 1] = part
        } finally {
          inFlightBytes -= reservedBytes
          capacity.resolve()
          capacity = Promise.withResolvers<void>()
        }
      }
    } catch (error) {
      if (stopped) return
      stopped = true
      throw error
    }
    return undefined
  }))
  // Stop scheduling on any failure, and drain already-started reads before
  // responding so none outlive the tracked request or reject unhandled.
  for (const result of workers) {
    if (result.status === 'rejected') throw result.reason
    if (result.value) { sendJson(res, result.value.status, { error: result.value.error }); return }
  }
  const links = mergeLinkGroups(snapshot.linkRevision ? await deps.db.getEnabledLinkGroups(snapshot.linkRevision) : [], findingIds)
  // Access to an earlier report may change while a later blob is fetched.
  // Reject the whole answer if any content/access/assignment snapshot changed.
  const current = await deps.db.getReportAccessSnapshot(s.session.id, Date.now(), ids)
  if (!current || current.user.id !== snapshot.user.id) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (current.linkRevision !== snapshot.linkRevision || current.user.role !== snapshot.user.role || current.reports.length !== reports.size
    || current.reports.some(report => JSON.stringify(report) !== JSON.stringify(reports.get(report.id)))) {
    sendJson(res, 404, { error: 'no-report' }); return
  }
  const suffix = Buffer.from(links.length > 0 ? `],"links":${JSON.stringify(links)}}` : ']}')
  outputBytes += suffix.length - 2
  if (outputBytes > MAX_REPORT_QUERY_BYTES) { sendJson(res, 413, { error: 'batch-too-large' }); return }
  parts.push(suffix)
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  writeResponseParts(res, parts, outputBytes)
}

// The server selects the complete published workspace for classification.
// Privileged hidden-report previews are independently scoped and bounded.
// Its reports' file trees are asked for apart, by its graph or Files alone.
async function handleTeamReports(res: ServerResponse, deps: ManagedHttpDeps, session: ManagedSession, teamId: string, reportId: string | null,
  part: 'reports' | 'trees' = 'reports'): Promise<void> {
  const snapshot = await teamSnapshot(deps.db, session.id, teamId, reportId)
  const body = await (part === 'trees' ? loadTeamTreesResponse : loadTeamReportsResponse)(deps.db, deps.reportStore, snapshot)
  await recheckTeam(deps.db, session.id, snapshot)
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  writeResponse(res, body)
}

// Triage requires both a writing role and access to the report itself.
async function canTriageReport(deps: ManagedHttpDeps, user: StoredUser, reportId: string): Promise<boolean> {
  return roleAtLeast(user.role, 'triage') && await canViewReport(deps, user, reportId)
}

// Ordinary users authorize annotations through the complete team's filtered
// workspace. Privileged users retain report-scoped access and the same stable
// ID derivation. Both paths store/read annotations by finding ID alone.
const VISIBLE_IDS_CACHE_MAX = 256
const visibleIdsCaches = new WeakMap<ManagedHttpDeps, Map<string, Set<string>>>()
async function visibleFindingIds(deps: ManagedHttpDeps, user: StoredUser, reportId: string, sessionId: string, teamId: string | null): Promise<Set<string>> {
  if (!roleAtLeast(user.role, 'manage')) {
    if (!teamId) throw new TeamReportsError(404, 'no-team')
    return teamFindingIds(deps.db, deps.reportStore, sessionId, teamId, reportId)
  }
  const rec = await deps.db.getReport(reportId)
  if (rec == null) return new Set()
  return reportFindingIds(deps, rec, await repositoryName(deps, rec.repoId))
}
// A whole report's finding ids, kept by its content, name and repository,
// the one read least recently dropped first.
async function reportFindingIds(deps: ManagedHttpDeps, rec: { id: string; sha256: string; filename: string }, github: string | null): Promise<Set<string>> {
  const key = JSON.stringify([rec.id, rec.sha256, rec.filename, { github }])
  let cache = visibleIdsCaches.get(deps)
  if (cache == null) { cache = new Map(); visibleIdsCaches.set(deps, cache) }
  const hit = cache.get(key)
  if (hit != null) { cache.delete(key); cache.set(key, hit); return hit }
  const bytes = await deps.reportStore.get(rec.id)
  if (bytes == null) return new Set()
  const { data } = readManagedReport(bytes.toString('utf8'), rec.filename)
  if (data == null) return new Set()
  // The ids the team workspace derives (teamFindingIds), from the one parse.
  const ids = await reportIds(data)
  ids.delete('')
  while (cache.size >= VISIBLE_IDS_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  cache.set(key, ids)
  return ids
}

// GET /api/reports/<id>/triage — the stored triage entries for the findings of
// a report the caller may view (canViewReport; 404 hides existence and denial
// alike, matching handleViewReport). Entries are keyed by finding id and shared
// by every report carrying the finding; a viewer only receives entries for
// findings their visibility permissions keep in THIS report — an entry on a
// stripped finding must not leak that the finding exists. A cleared entry is
// sent as null (the server's tombstone), distinct from one never set.
async function handleGetReportTriage(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string, teamId: string | null): Promise<void> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now(), { handed: true })
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!(await canViewReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  await visibleFindingIds(deps, s.user, id, s.session.id, teamId)
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!current || !(await canViewReport(deps, current.user, id)) || current.user.role !== s.user.role) { sendJson(res, 404, { error: 'no-report' }); return }
  const visible = await visibleFindingIds(deps, current.user, id, current.session.id, teamId)
  const entries: Record<string, TriageEntryPatch | null> = {}
  for (const row of await deps.db.listTriage([...visible])) entries[row.findingId] = triageWireEntry(row)
  sendJson(res, 200, { entries })
}

// GET /api/reports/<id>/triage/history?finding=<fid> — one finding's triage
// trail (newest first, capped). The caller must have at least triage access
// to the report, and the finding is one their visibility permissions
// keep in it (a stripped or foreign id 404s without revealing whether it
// exists). Each event is the entry as written then (null = a clear), who
// wrote it and when; "what changed" is the diff against the next-older event.
async function handleGetReportTriageHistory(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string, query: URLSearchParams, teamId: string | null): Promise<void> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now(), { handed: true })
  if (s == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!(await canTriageReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  const finding = query.get('finding') ?? ''
  if (finding === '' || finding.length > MAX_FINDING_ID) { sendJson(res, 400, { error: 'bad-request' }); return }
  await visibleFindingIds(deps, s.user, id, s.session.id, teamId)
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!current || !(await canTriageReport(deps, current.user, id)) || current.user.role !== s.user.role) { sendJson(res, 404, { error: 'no-report' }); return }
  const visible = await visibleFindingIds(deps, current.user, id, current.session.id, teamId)
  if (!visible.has(finding)) { sendJson(res, 404, { error: 'no-finding' }); return }
  const events = (await deps.db.listTriageHistory(finding, MAX_TRIAGE_HISTORY)).map((row: TriageEventRow) => ({
    seq: row.seq, at: row.at, actorId: row.actorId, actorLogin: row.actorLogin, actorName: row.actorName,
    batchId: row.batchId, entry: triageWireEntry(row, true),
  }))
  // A database read can outlive a role, membership, or visibility change.
  const latest = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!latest || latest.user.role !== current.user.role || !(await canTriageReport(deps, latest.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  if (!(await visibleFindingIds(deps, latest.user, id, latest.session.id, teamId)).has(finding)) { sendJson(res, 404, { error: 'no-finding' }); return }
  sendJson(res, 200, { finding, events })
}

// POST /api/reports/<id>/triage — write triage entries for a report's findings.
// Mutation: same-origin + CSRF, then canTriageReport (404 on any failure — role
// too low, no membership, or no such report). Body { entries: { <findingId>:
// entry|null } } — whole-entry replace, last write wins, null clears the entry
// (a tombstone, so a later reader adopts the clear); each entry validates
// through parseTriageEntryPatch (400 on a malformed one). Every id must be a
// finding the writer sees in THIS report — the report is the authorization
// scope for rows that are themselves per finding id — so a stripped (or
// foreign) finding id 404s without revealing whether it exists.
async function handleSetReportTriage(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string, teamId: string | null): Promise<void> {
  const s = await checkMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  if (!(await canTriageReport(deps, s.user, id))) { sendJson(res, 404, { error: 'no-report' }); return }
  let body: unknown
  try { body = await readJsonBody(req, MAX_TRIAGE_BODY_BYTES) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const raw = (body as { entries?: unknown } | null)?.entries
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) { sendJson(res, 400, { error: 'bad-request' }); return }
  const pairs = Object.entries(raw)
  if (pairs.length > MAX_TRIAGE_ENTRIES) { sendJson(res, 400, { error: 'too-many-entries' }); return }
  const parsed: [string, TriageEntryPatch | null][] = []
  for (const [findingId, value] of pairs) {
    const patch = parseTriageEntryPatch(value)
    if (value != null && typeof value === 'object' && Object.hasOwn(value, 'comment')) {
      sendJson(res, 400, { error: 'use-comments-endpoint' }); return
    }
    if (patch === 'invalid' || findingId === '' || findingId.length > MAX_FINDING_ID) {
      sendJson(res, 400, { error: 'bad-entry' }); return
    }
    parsed.push([findingId, patch])
  }
  await visibleFindingIds(deps, s.user, id, s.session.id, teamId)
  const current = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!current || !(await canViewReport(deps, current.user, id)) || current.user.role !== s.user.role) { sendJson(res, 404, { error: 'no-report' }); return }
  const visible = await visibleFindingIds(deps, current.user, id, current.session.id, teamId)
  if (parsed.some(([findingId]) => !visible.has(findingId))) {
    sendJson(res, 404, { error: 'no-finding' }); return
  }
  await deps.db.setTriageEntries(parsed, s.user.id, s.user.login, Date.now(), id)
  sendJson(res, 200, { ok: true })
}

// GET only: clients match local annotations against these IDs without sending
// their local finding IDs or annotation bodies to discover which reports exist.
async function handleImportFindingIds(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, search: URLSearchParams): Promise<void> {
  const s = await readAdminSession(res, deps, cookie, { handed: true })
  if (!s) return
  const after = search.get('after') ?? ''
  if (after && !/^[a-f\d-]{36}$/iu.test(after)) { sendJson(res, 400, { error: 'bad-cursor' }); return }
  const stored = await deps.db.listFindingCatalogReports(after, FINDING_CATALOG_PAGE_COUNT + 1)
  const reports = []
  let bytes = 0, cursor = after, processed = 0
  for (const report of stored) {
    if (processed >= FINDING_CATALOG_PAGE_COUNT || (processed > 0 && bytes + report.byteSize > FINDING_CATALOG_PAGE_BYTES)) break
    bytes += report.byteSize
    processed++
    cursor = report.id
    const findingIds = [...await visibleFindingIds(deps, s.user, report.id, s.session.id, null)]
    if (findingIds.length > 0) reports.push({ id: report.id, findingIds })
  }
  if (await readAdminSession(res, deps, cookie) == null) return
  sendJson(res, 200, { reports, nextCursor: processed < stored.length ? cursor : null })
}

// Admin imports compare the exact snapshot shown by the conflict dialog before
// writing. The store commits shared finding triage and imported comments together.
async function handleImportTriage(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, id: string): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie, { handed: true })
  if (!s) return
  let body: { findingIds?: unknown; entries?: unknown; expected?: unknown }
  try { body = await readJsonBody(req, MAX_TRIAGE_BODY_BYTES) as typeof body }
  catch { sendJson(res, 400, { error: 'bad-body' }); return }
  if (!body || typeof body !== 'object') { sendJson(res, 400, { error: 'bad-body' }); return }
  const reading = body.entries === undefined
  const raw = body.entries
  if (!reading && (!raw || typeof raw !== 'object' || Array.isArray(raw))) { sendJson(res, 400, { error: 'bad-entries' }); return }
  const ids = reading ? body.findingIds : Object.keys(raw!)
  if (!Array.isArray(ids) || ids.length > MAX_TRIAGE_ENTRIES || ids.some(value => typeof value !== 'string' || !value || value.length > MAX_FINDING_ID)) {
    sendJson(res, 400, { error: 'bad-finding-ids' }); return
  }
  const parsed: [string, TriageEntryPatch | null][] = []
  const expected = body.expected as Record<string, string> | null
  if (!reading) {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) { sendJson(res, 400, { error: 'bad-expected' }); return }
    for (const [findingId, value] of Object.entries(raw!)) {
      const patch = parseTriageEntryPatch(value)
      if (patch === 'invalid' || !/^[a-f\d]{64}$/u.test(expected[findingId] ?? '')) { sendJson(res, 400, { error: 'bad-entry' }); return }
      parsed.push([findingId, patch])
    }
  }
  if (!(await deps.db.getReport(id))) { sendJson(res, 404, { error: 'no-report' }); return }
  const visible = await visibleFindingIds(deps, s.user, id, s.session.id, null)
  if (await readAdminSession(res, deps, cookie) == null) return
  if (ids.some(findingId => !visible.has(findingId))) { sendJson(res, 404, { error: 'no-finding' }); return }
  if (reading) { sendJson(res, 200, { snapshots: await deps.db.getImportTriage(ids) }); return }
  const applied = await deps.db.importTriage(parsed, expected!, { id: s.user.id, login: s.user.login }, id, Date.now())
  sendJson(res, applied ? 200 : 409, { ok: applied })
}

// A report grants access to its visible findings; comments themselves are
// shared by finding ID. Author IDs always come from the authenticated session.
async function handleReportComments(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, reportId: string, commentId: string | null, teamId: string | null): Promise<void> {
  const method = req.method ?? 'GET'
  if (commentId == null ? method !== 'GET' && method !== 'POST' : method !== 'PATCH' && method !== 'DELETE') {
    send405(res, commentId == null ? 'GET, POST' : 'PATCH, DELETE'); return
  }
  const s = method === 'GET' ? await readSession(deps.config, deps.db, cookie, Date.now(), { handed: true }) : await checkMutation(req, res, deps, cookie, { handed: true })
  if (s == null) { if (method === 'GET') sendJson(res, 401, { error: 'unauthenticated' }); return }
  const allowed = method === 'GET' ? await canViewReport(deps, s.user, reportId) : await canTriageReport(deps, s.user, reportId)
  if (!allowed) { sendJson(res, 404, { error: 'no-report' }); return }
  let raw: { body?: unknown; findingId?: unknown; version?: unknown } | null
  if (method === 'GET') raw = null
  else {
    try { raw = await readJsonBody(req, MAX_TRIAGE_BODY_BYTES) as typeof raw } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  }
  // Body delivery and a cold report read can outlive a permission change.
  // Match triage's recheck before exposing or changing any annotation.
  await visibleFindingIds(deps, s.user, reportId, s.session.id, teamId)
  const session = await readSession(deps.config, deps.db, cookie, Date.now())
  if (!session || session.user.role !== s.user.role || !(await canViewReport(deps, session.user, reportId))) {
    sendJson(res, 404, { error: 'no-report' }); return
  }
  const visible = await visibleFindingIds(deps, session.user, reportId, session.session.id, teamId)
  if (method === 'GET') {
    sendJson(res, 200, { comments: await deps.db.listComments([...visible]) }); return
  }
  const body = parseCommentBody(raw?.body)
  if (body == null && method !== 'DELETE') { sendJson(res, 400, { error: 'bad-comment' }); return }
  if (commentId == null) {
    if (typeof raw?.findingId !== 'string' || !visible.has(raw.findingId)) { sendJson(res, 404, { error: 'no-finding' }); return }
    const comment = await deps.db.createComment({ findingId: raw.findingId, body: body!, authorId: session.user.id, authorLogin: session.user.login, reportId }, Date.now())
    sendJson(res, 201, { comment }); return
  }
  const current = await deps.db.getComment(commentId)
  if (current == null || !visible.has(current.findingId)) { sendJson(res, 404, { error: 'no-comment' }); return }
  const allowedComment = method === 'DELETE' ? canDeleteComment(current, session.user) : current.authorId === session.user.id
  if (!allowedComment) { sendJson(res, 403, { error: 'not-comment-author' }); return }
  if (typeof raw?.version !== 'number' || !Number.isSafeInteger(raw.version) || raw.version < 1) {
    sendJson(res, 400, { error: 'bad-version' }); return
  }
  const comment = method === 'DELETE'
    ? await deps.db.deleteComment(commentId, session.user.id, session.user.login, raw.version, reportId, Date.now())
    : await deps.db.editComment(commentId, session.user.id, session.user.login, body!, raw.version, reportId, Date.now())
  if (comment === 'conflict') { sendJson(res, 409, { error: 'comment-changed' }); return }
  if (comment === 'forbidden') { sendJson(res, 403, { error: 'not-comment-author' }); return }
  if (comment == null) { sendJson(res, 404, { error: 'no-comment' }); return }
  if (comment === 'deleted') { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return }
  sendJson(res, 200, { comment })
}

// GET /api/admin/teams — every team (members + repos inlined) plus the pickers
// the page needs: all users (member dropdown), selected repos (repo dropdown),
// and the visibility-permission keys. admin, read-only (no CSRF).
async function handleListTeams(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await readAdminSession(res, deps, cookie, { handed: true })
  if (s == null) return
  const scopes = await deps.db.listTeamNpmScopes()
  const reviewTeams = new Set(await deps.db.listDependencyReviewEnabledTeams())
  sendJson(res, 200, {
    teams: (await deps.db.listTeams()).map(team => ({ ...team, npmScopes: scopes[team.id] ?? [], dependencyReview: reviewTeams.has(team.id) })),
    users: await deps.db.listUserOptions(),
    repos: selectableRepos(await deps.db.listSelectedRepos()),
    permissions: VISIBILITY_PERMISSIONS,
  })
}

// POST /api/admin/teams — create a team. Body { name }. 409 if the name's taken.
async function handleCreateTeam(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const rawName = (body as { name?: unknown } | null)?.name
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (name === '' || name.length > MAX_TEAM_NAME) { sendJson(res, 400, { error: 'bad-name' }); return }
  const id = randomUUID()
  if (await readAdminSession(res, deps, cookie) == null) return
  if (!(await deps.db.createTeam(id, name, Date.now()))) { sendJson(res, 409, { error: 'name-taken' }); return }
  await activity(deps, s.user, 'access', `created team ${name}`)
  sendJson(res, 201, await deps.db.getTeam(id))
}

// POST /api/admin/teams/rename — rename a team. Body { teamId, name }. 404 if no
// such team; 409 if the new name is already taken by another team.
async function handleRenameTeam(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  const rawName = (body as { name?: unknown } | null)?.name
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (typeof teamId !== 'string' || name === '' || name.length > MAX_TEAM_NAME) { sendJson(res, 400, { error: 'bad-name' }); return }
  const team = await deps.db.getTeam(teamId)
  if (await readAdminSession(res, deps, cookie) == null) return
  const result = await deps.db.renameTeam(teamId, name, Date.now())
  if (result === 'not-found') { sendJson(res, 404, { error: 'no-team' }); return }
  if (result === 'name-taken') { sendJson(res, 409, { error: 'name-taken' }); return }
  if (team?.name !== name) await activity(deps, s.user, 'access', `renamed team ${team?.name ?? teamId} to ${name}`)
  sendJson(res, 200, { ok: true, name })
}

// Hidden teams retain their configuration but grant no access or sidebar presence.
async function handleSetTeamHidden(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  const hidden = (body as { hidden?: unknown } | null)?.hidden
  if (typeof teamId !== 'string' || typeof hidden !== 'boolean') { sendJson(res, 400, { error: 'bad-request' }); return }
  const team = await deps.db.getTeam(teamId)
  if (await readAdminSession(res, deps, cookie) == null) return
  if (!(await deps.db.setTeamHidden(teamId, hidden, Date.now()))) { sendJson(res, 404, { error: 'no-team' }); return }
  if (team?.hidden !== hidden) await activity(deps, s.user, 'access', `${hidden ? 'hid' : 'restored'} team ${team?.name ?? teamId}`)
  sendJson(res, 200, { ok: true, hidden })
}

// POST /api/admin/teams/delete — drop a team (its links cascade). Body { teamId }.
async function handleDeleteTeam(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  if (typeof teamId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  const team = await deps.db.getTeam(teamId)
  if (await readAdminSession(res, deps, cookie) == null) return
  if (!(await deps.db.deleteTeam(teamId))) { sendJson(res, 404, { error: 'no-team' }); return }
  await activity(deps, s.user, 'access', `deleted team ${team?.name ?? teamId}`)
  sendJson(res, 200, { ok: true })
}

// POST /api/admin/teams/set-repo — add a repo path. Empty path replaces all
// path links with the whole repository. Body { teamId, repoId, path? }.
// Repo must be in the selected set.
async function handleSetTeamRepo(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  const repoId = (body as { repoId?: unknown } | null)?.repoId
  if (typeof teamId !== 'string' || typeof repoId !== 'number' || !Number.isSafeInteger(repoId)) {
    sendJson(res, 400, { error: 'bad-request' }); return
  }
  const path = normalizeTeamPath((body as { path?: unknown }).path)
  if (!path.ok) { sendJson(res, 400, { error: 'bad-path' }); return }
  const team = (await deps.db.listTeams()).find(row => row.id === teamId)
  if (team == null) { sendJson(res, 404, { error: 'no-team' }); return }
  if (!(await deps.db.listSelectedRepos()).some((r) => r.repoId === repoId)) { sendJson(res, 400, { error: 'repo-not-selected' }); return }
  if (await readAdminSession(res, deps, cookie) == null) return
  await deps.db.setTeamRepo(teamId, repoId, path.path)
  if (!team.repos.some(repo => repo.repoId === repoId && (!repo.path || repo.path === (path.path ?? '')))) {
    await activity(deps, s.user, 'access', `granted team ${team.name} access to ${path.path || '/'}`, { repo: await repositoryName(deps, repoId) })
  }
  sendJson(res, 200, { ok: true })
}

// POST /api/admin/teams/remove-repo — unlink one path. Omitting path retains
// the legacy remove-all behavior. Body { teamId, repoId, path? }.
async function handleRemoveTeamRepo(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  const repoId = (body as { repoId?: unknown } | null)?.repoId
  if (typeof teamId !== 'string' || typeof repoId !== 'number' || !Number.isSafeInteger(repoId)) { sendJson(res, 400, { error: 'bad-request' }); return }
  const rawPath = (body as { path?: unknown }).path
  if (rawPath !== undefined && rawPath !== null && typeof rawPath !== 'string') { sendJson(res, 400, { error: 'bad-path' }); return }
  const path = normalizeTeamPath(rawPath)
  if (!path.ok) { sendJson(res, 400, { error: 'bad-path' }); return }
  if (await readAdminSession(res, deps, cookie) == null) return
  if (!(await deps.db.removeTeamRepo(teamId, repoId, rawPath === undefined ? undefined : path.path))) { sendJson(res, 404, { error: 'not-linked' }); return }
  await activity(deps, s.user, 'access', `removed team ${(await deps.db.getTeam(teamId))?.name ?? teamId}'s access to ${rawPath === undefined ? 'all paths' : path.path || '/'}`, { repo: await repositoryName(deps, repoId) })
  sendJson(res, 200, { ok: true })
}

// POST /api/admin/teams/set-member — add/update a member + their visibility
// permissions. Body { teamId, userId, dependencies?, security? }.
async function handleSetTeamMember(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  const userId = (body as { userId?: unknown } | null)?.userId
  if (typeof teamId !== 'string' || typeof userId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  const team = (await deps.db.listTeams()).find(row => row.id === teamId)
  if (team == null) { sendJson(res, 404, { error: 'no-team' }); return }
  const user = (await deps.db.listUserOptions()).find(row => row.id === userId)
  if (user == null) { sendJson(res, 404, { error: 'no-user' }); return }
  const permissions = parseTeamUserPermissions(body)
  const member = team.members.find(row => row.userId === userId)
  if (await readAdminSession(res, deps, cookie) == null) return
  await deps.db.setTeamMember(teamId, userId, permissions)
  if (!member || member.dependencies !== permissions.dependencies || member.security !== permissions.security) {
    await activity(deps, s.user, 'access', `set ${user.login}'s membership in ${team.name} (dependencies: ${permissions.dependencies ? 'on' : 'off'}, security: ${permissions.security ? 'on' : 'off'})`)
  }
  sendJson(res, 200, { ok: true })
}

// POST /api/admin/teams/remove-member — remove a membership. Body { teamId, userId }.
async function handleRemoveTeamMember(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  const userId = (body as { userId?: unknown } | null)?.userId
  if (typeof teamId !== 'string' || typeof userId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  if (await readAdminSession(res, deps, cookie) == null) return
  if (!(await deps.db.removeTeamMember(teamId, userId))) { sendJson(res, 404, { error: 'not-member' }); return }
  const team = await deps.db.getTeam(teamId)
  const user = (await deps.db.listUserOptions()).find(row => row.id === userId)
  await activity(deps, s.user, 'access', `removed ${user?.login ?? userId} from team ${team?.name ?? teamId}`)
  sendJson(res, 200, { ok: true })
}

async function handleSetTeamDependencyReview(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie, { handed: true })
  if (!s) return
  let body
  try { body = await readJsonBody(req) as { teamId?: unknown; enabled?: unknown } } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  if (typeof body?.teamId !== 'string' || typeof body?.enabled !== 'boolean') { sendJson(res, 400, { error: 'bad-request' }); return }
  if (!await deps.db.setTeamDependencyReview(s.session.id, body.teamId, body.enabled)) { sendJson(res, 404, { error: 'no-team' }); return }
  sendJson(res, 200, { ok: true })
}

// POST /api/admin/teams/set-npm-scopes — replace the npm scopes whose private
// packages the team's members may read. Body { teamId, scopes: ['@scope'] }.
async function handleSetTeamNpmScopes(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined): Promise<void> {
  const s = await adminMutation(req, res, deps, cookie, { handed: true })
  if (s == null) return
  let body: unknown
  try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  const teamId = (body as { teamId?: unknown } | null)?.teamId
  if (typeof teamId !== 'string') { sendJson(res, 400, { error: 'bad-request' }); return }
  const team = await deps.db.getTeam(teamId)
  const changed = await deps.db.setTeamNpmScopes(s.session.id, teamId, (body as { scopes?: unknown }).scopes)
  if (changed == null) { sendJson(res, 404, { error: 'no-team' }); return }
  const parts = [changed.added.length > 0 ? `added ${changed.added.join(', ')}` : '', changed.removed.length > 0 ? `removed ${changed.removed.join(', ')}` : ''].filter(Boolean)
  if (parts.length > 0) await activity(deps, s.user, 'access', `changed team ${team?.name ?? teamId}'s npm scopes: ${parts.join('; ')}`)
  sendJson(res, 200, { ok: true, scopes: (await deps.db.listTeamNpmScopes())[teamId] ?? [] })
}

// Who reads npm packages now: a session with workspace access, its role and,
// where they count for any of `names` it is asked about (npmScopesCount), the
// npm scopes of its visible teams, else none: none are read for an unscoped
// package, an admin or a manager, or an answer checked again that is public.
// Null for none.
async function npmReader(deps: ManagedHttpDeps, cookie: string | undefined, names: readonly string[], { handed = false } = {}): Promise<NpmReader | null> {
  const s = await readSession(deps.config, deps.db, cookie, Date.now(), { handed })
  return s == null ? null : npmReaderOf(deps, s.user, names)
}
// The reader of the session `cookie` names now, as npmReader reads them,
// their npm scopes whatever the packages, and whether they read team
// `teamId`'s reviews: one statement.
async function npmReviewReader(deps: ManagedHttpDeps, cookie: string | undefined, teamId: string): Promise<(NpmReader & { readsTeam: boolean }) | null> {
  const ids = sessionIds(deps.config, cookie)
  const reader = ids && await deps.db.getNpmReviewReader(ids.id, ids.viewer, Date.now(), teamId)
  return reader && roleAtLeast(reader.role, 'view') ? { role: reader.role, scopes: new Set(reader.scopes), userId: reader.id, readsTeam: reader.readsTeam } : null
}
// The same of `user`, as a session the request read just now tells them.
async function npmReaderOf(deps: ManagedHttpDeps, user: { id: string; role: NpmReader['role'] }, names: readonly string[]): Promise<NpmReader | null> {
  if (!roleAtLeast(user.role, 'view')) return null
  return { role: user.role, scopes: new Set(npmScopesCount(user.role, names) ? await deps.db.listUserNpmScopes(user.id) : []), userId: user.id }
}

// What a registry read found, or a 404 for the package (handleNpm's catch
// answers it) where it found none.
function found<T>(value: T | null | undefined): T {
  if (value == null) throw new NpmPackageError(404, 'package-not-found')
  return value
}

// Version documents a list of reviews reads at once: each holds a version
// document's room in what npm's reads may hold at once (npm-packages.ts),
// which refuses past thirty-two of them.
const REVIEW_READS_AT_ONCE = 8

// Lists must enforce the same target and base access as the review itself,
// including permission changes while the registry requests are in flight;
// first as `session`, the one the request read just now, where given. A
// team's (`teamId`) only to one who still reads its reviews there, asked
// again with the rest (npmReviewReader).
async function readableNpmReviews<T extends ReviewContext>(res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, user: string, reviews: T[],
  session?: { id: string; role: NpmReader['role'] }, teamId?: string): Promise<T[] | null> {
  const controller = new AbortController()
  const onClose = () => { if (!res.writableEnded) controller.abort() }
  res.on('close', onClose)
  try {
    const names = reviews.flatMap(review => [review.package, ...review.basePackage ? [review.basePackage] : []])
    const reader = session ? await npmReaderOf(deps, session, names) : await npmReader(deps, cookie, names)
    if (!reader || reader.userId !== user) { sendJson(res, 401, { error: 'unauthenticated' }); return null }
    // Public versions' documents as the viewer keeps them (npm-kept.ts), a
    // day, all read of the database at once: a list asks npm for none it read
    // within it. Each version once, as many at once as REVIEW_READS_AT_ONCE.
    const versionsOf = (review: T) => [[review.package, review.version], ...review.basePackage ? [[review.basePackage, review.baseVersion!]] : []] as [string, string][]
    const asked = new Map(reviews.flatMap(versionsOf).map(([name, version]) => [`${name}\0${version}`, [name, version] as const]))
    const store = npmVersionStore(deps.db, deps.config.debug)
    const held = await store.readMany?.([...asked.values()].map(([name, version]) => ({ name, version }))) ?? new Map()
    const kept: NpmVersionStore = { read: (name, version) => Promise.resolve(held.get(`${name}@${version}`) ?? null), write: store.write }
    const read = await eachOf([...asked], REVIEW_READS_AT_ONCE, ([, [name, version]]) => readNpmVersion(name, version, canReadPrivateNpm(reader, name), controller.signal, kept))
    const documents = new Map([...asked.keys()].map((key, at) => [key, read[at] ?? null]))
    const packages = reviews.map(review => versionsOf(review).map(([name, version]) => documents.get(`${name}\0${version}`) ?? null))
    const current = teamId === undefined ? await npmReader(deps, cookie, packages.flat().flatMap(doc => doc?.private ? [doc.name] : []))
      : await npmReviewReader(deps, cookie, teamId)
    if (!current || current.userId !== user) { sendJson(res, 401, { error: 'unauthenticated' }); return null }
    if ('readsTeam' in current && !current.readsTeam) { sendJson(res, 404, { error: 'no-team' }); return null }
    return reviews.filter((_, index) => packages[index]!.every(doc => doc && (!doc.private || canReadPrivateNpm(current, doc.name))))
  } catch (error) {
    if (controller.signal.aborted) return null
    if (error instanceof NpmPackageError) { sendJson(res, error.status, { error: error.message }); return null }
    throw error
  } finally { res.off('close', onClose) }
}

const githubRepoOf = (doc: NpmVersionDocument) => (doc.manifest['github'] as { github?: string } | undefined)?.github ?? null

function npmAdvisoryOptions(deps: ManagedHttpDeps, githubToken: NpmAdvisoryOptions['githubToken'], latestDoc: () => Promise<NpmVersionDocument | null>): NpmAdvisoryOptions {
  return {
    githubToken,
    repo: async () => { const doc = await latestDoc(); return doc && githubRepoOf(doc) },
    cache: signal => auditCache(deps.config.upstreamCacheDir, deps.db, signal, deps.config.debug),
    lastListing: repo => lastListing(deps.config.upstreamCacheDir, deps.db, repo, deps.config.debug),
    debug: deps.config.debug,
  }
}

// Read the same target-version evidence as the viewer. Missing upstream
// reports impose no extra verdict restriction; detected findings do.
async function npmReviewPublicationLimit(deps: ManagedHttpDeps, reader: NpmReader, doc: NpmVersionDocument, signal: AbortSignal) {
  if (npmTakenDown({ npm: doc })) return 'reject' as const
  const privileged = canReadPrivateNpm(reader, doc.name)
  const advisories = async () => {
    const versions = await readNpmVersions(doc.name, privileged, signal)
    if (!versions) return null
    return npmAdvisories(doc.name, versions.versions, npmAdvisoryOptions(deps,
      () => ensureUserAccessToken(deps.config, deps.db, reader.userId, Date.now()).catch(() => null),
      () => readNpmVersion(doc.name, 'latest', privileged, signal)))
  }
  const [list, socket, risk] = await Promise.all([advisories().catch(() => null), doc.private ? null : npmSocketReport(doc.name, doc.version).catch(() => null),
    npmRisk(doc, null, { db: deps.db, npmCache: deps.npmCacheStorage, debug: deps.config.debug, teamScoped: true, privileged, signal })])
  return npmReviewVerdictLimit(doc, list, socket, risk)
}

// Reviews are scoped to the bytes actually displayed, including the base:
// each change but a revocation loads both versions' files, of tarballs held
// to their integrity and to their shasum where npm tells one (npm-loads.ts),
// and the review keeps those shasums. Access to both versions is rechecked
// before returning or saving annotations.
async function handleNpmReviews(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, params: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET'
  if (!['GET', 'POST'].includes(method)) { send405(res, 'GET, POST'); return }
  const mutation = method !== 'GET'
  const session = mutation ? await checkMutation(req, res, deps, cookie, { handed: true }) : await readSession(deps.config, deps.db, cookie, Date.now(), { handed: true })
  if (!session) { if (!mutation) sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!roleAtLeast(session.user.role, mutation ? 'triage' : 'view')) { sendJson(res, 403, { error: 'forbidden' }); return }
  let body: Record<string, unknown> = {}
  if (mutation) {
    try {
      const raw = await readJsonBody(req, 128 * 1024)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bad-body')
      body = raw as Record<string, unknown>
    } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  }
  const field = (key: string) => mutation ? body[key] : params.get(key)
  const name = field('package')
  const version = field('version')
  const integrity = field('integrity')
  const basePackage = field('basePackage') ?? null
  const baseVersion = field('baseVersion') ?? null
  const baseIntegrity = field('baseIntegrity') ?? null
  const validIntegrity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024
  if (field('ecosystem') !== 'npm' || !isNpmPackageName(name) || !isNpmPackageSpec(version) || !validIntegrity(integrity)
    || (basePackage !== null || baseVersion !== null || baseIntegrity !== null)
      && (!isNpmPackageName(basePackage) || !isNpmPackageSpec(baseVersion) || !validIntegrity(baseIntegrity))) {
    sendJson(res, 400, { error: 'bad-review-context' }); return
  }
  const context: ReviewContext = { ecosystem: 'npm', package: name, version, integrity,
    basePackage: basePackage as string | null, baseVersion: baseVersion as string | null, baseIntegrity: baseIntegrity as string | null }
  let change: ReviewChange | null = null
  if (mutation) {
    const action = body['action'], reviewId = body['reviewId'] ?? null, revision = body['revision'] ?? null
    if (typeof action !== 'string' || !['start', 'save', 'publish', 'continue', 'revoke'].includes(action)
      || (reviewId !== null && (typeof reviewId !== 'string' || reviewId.length === 0 || reviewId.length > 100 || !Number.isSafeInteger(revision) || Number(revision) < 1))
      || (!['save', 'start'].includes(action) && reviewId === null) || (action === 'start' && reviewId !== null)) { sendJson(res, 400, { error: 'bad-review' }); return }
    if (action === 'start') change = { action, reviewId: null, revision: null }
    else if (action === 'publish') {
      const teamIds = body['teamIds']
      if (!Array.isArray(teamIds) || teamIds.length === 0 || teamIds.length > 100 || teamIds.some(id => typeof id !== 'string' || id.length > 100)) {
        sendJson(res, 400, { error: 'bad-review-teams' }); return
      }
      const finalComment = body['finalComment'] ?? '', finalStatus = body['finalStatus'] ?? null
      if (typeof finalComment !== 'string' || finalComment.length > 20000 || finalStatus !== null
        && (typeof finalStatus !== 'string' || !['accept', 'accept-with-nits', 'request-changes', 'reject'].includes(finalStatus))) {
        sendJson(res, 400, { error: 'bad-final-verdict' }); return
      }
      change = { action, reviewId: reviewId as string, revision: revision as number, teamIds, files: [], nonTextFiles: [],
        final: finalStatus === null ? null : { status: finalStatus as ReviewInput['status'] & string, comment: finalComment } }
    } else if (action === 'continue' || action === 'revoke') change = { action, reviewId: reviewId as string, revision: revision as number }
    else {
      const file = body['file']
      const comment = body['comment']
      const status = body['status'] ?? null
      const entryId = body['entryId'] ?? null
      if (typeof file !== 'string' || !file || file.length > 4096 || file.includes('\0')
        || (entryId !== null && (typeof entryId !== 'string' || entryId.length === 0 || entryId.length > 100))
        || typeof comment !== 'string' || comment.length > 20000
        || (status !== null && (typeof status !== 'string' || !['accept', 'accept-with-nits', 'request-changes', 'reject'].includes(status))) || (status === null && entryId === null)) {
        sendJson(res, 400, { error: 'bad-review' }); return
      }
      change = { action: 'save', reviewId: reviewId as string | null, revision: revision as number | null, entryId: entryId as string | null,
        entry: { file, comment, status: status as ReviewInput['status'] } }
    }
  }
  const controller = new AbortController()
  const onClose = () => { if (!res.writableEnded) controller.abort() }
  res.on('close', onClose)
  try {
    const reader = await npmReader(deps, cookie, [context.package, ...context.basePackage ? [context.basePackage] : []])
    if (!reader || reader.userId !== session.user.id) { sendJson(res, 401, { error: 'unauthenticated' }); return }
    const kept = readTogether(npmVersionStore(deps.db, deps.config.debug), [{ name, version }, ...context.basePackage ? [{ name: context.basePackage, version: context.baseVersion! }] : []])
    const read = (pkg: string, spec: string) => readNpmVersion(pkg, spec, canReadPrivateNpm(reader, pkg), controller.signal, kept)
    const [doc, base] = await Promise.all([read(name, version), context.basePackage ? read(context.basePackage, context.baseVersion!) : null])
    if (!doc || (context.basePackage && !base)) { sendJson(res, 404, { error: 'package-not-found' }); return }
    if (doc.version !== version || doc.dist.integrity !== integrity
      || (base && (base.version !== baseVersion || base.dist.integrity !== baseIntegrity))) {
      sendJson(res, 409, { error: 'review-content-changed' }); return
    }
    // Each change but a revocation loads both versions' files; a save or a
    // publication is held to them.
    const loads = change && change.action !== 'revoke' ? [doc, ...base ? [base] : []].map(loadNpmFiles) : []
    let tarballs: ReviewedTarballs | undefined
    try {
      const files = await Promise.all(loads.map(load => load.result))
      if (loads.length > 0) tarballs = { shasum: doc.dist.shasum, baseShasum: base?.dist.shasum ?? null }
      if (change?.action === 'publish' || change?.action === 'save') {
        const maps = files.map(list => new Map<string, unknown>(npmFileRows(list).map(([path, size, text, digest]) => [path, text ?? { format: 'digest', size, digest }])))
        const after = maps[0]!, before = maps[1] ?? new Map<string, unknown>()
        const diff = computeBundleDiff(before, after, () => '.')
        const changed: { path: string; basePath?: string }[] = [...diff.files.onlyBase, ...diff.files.onlyOther, ...diff.files.changed]
        const reviewable = (file: typeof changed[number]) => isReviewableFile(before.get(file.basePath ?? file.path), after.get(file.path))
        const reviewedPath = change.action === 'save' ? change.entry.file : null
        const reviewedFile = changed.find(file => file.path === reviewedPath)
        if (change.action === 'save' && !reviewedFile) { sendJson(res, 400, { error: 'unknown-review-file' }); return }
        if (change.action === 'save' && change.entry.status !== null && reviewedFile && !reviewable(reviewedFile)) { sendJson(res, 400, { error: 'non-text-review-file' }); return }
        if (change.action === 'publish') {
          change.files = changed.map(file => file.path)
          change.nonTextFiles = changed.filter(file => !reviewable(file)).map(file => file.path)
        }
      }
    } finally { loads.forEach(load => load.release()) }
    const limit = change?.action === 'publish' && change.final && change.final.status !== 'reject'
      ? await npmReviewPublicationLimit(deps, reader, doc, controller.signal) : 'accept'
    const current = await npmReader(deps, cookie, [doc, base].flatMap(item => item?.private ? [item.name] : []))
    if (!current || current.userId !== session.user.id) { sendJson(res, 401, { error: 'unauthenticated' }); return }
    if ([doc, base].some(item => item?.private && !canReadPrivateNpm(current, item.name))) { sendJson(res, 404, { error: 'package-not-found' }); return }
    if (!change) {
      const allBases = params.get('allBases') === 'true'
      const rows = await deps.db.listDependencyReviews(context, current.userId, allBases)
      const reviews = allBases ? await readableNpmReviews(res, deps, cookie, current.userId, rows, { id: current.userId, role: current.role }) : rows
      if (reviews) sendJson(res, 200, { reviews: await withFormatted(deps.reviewedDependencies ?? null, current.userId, reviews), teams: await deps.db.listDependencyReviewTeams(current.userId) })
      return
    }
    const checked = await checkMutation(req, res, deps, cookie)
    if (!checked) return
    if (checked.user.id !== current.userId || !roleAtLeast(checked.user.role, 'triage')) { sendJson(res, 403, { error: 'forbidden' }); return }
    if (change.action === 'publish' && change.final && !allowedReviewVerdicts([], limit).includes(change.final.status)) {
      sendJson(res, 400, { error: limit === 'reject' ? 'review-malware' : 'review-critical-vulnerability' }); return
    }
    const review = await deps.db.changeDependencyReview(context, checked.session.id, change, Date.now(), tarballs)
    sendJson(res, 200, { review: (await withFormatted(deps.reviewedDependencies ?? null, current.userId, [review]))[0] })
  } catch (err) {
    if (controller.signal.aborted) return
    if (err instanceof NpmPackageError) { sendJson(res, err.status, { error: err.message }); return }
    if (err instanceof NpmRiskError) { sendRiskError(res, err); return }
    throw err
  } finally { res.off('close', onClose) }
}

// GET /api/npm/deltas?versions=[[name, version, otherVersion], …]: the lines
// each of up to MAX_ASKED_DELTAS versions changes against another, or
// `(empty)`, as GET delta counts them, as lines of JSON as each is counted
// (`{ name, version, otherVersion, …delta }`, or `{ name, version,
// otherVersion, error, status }`), as a list's rows near the viewport ask
// for them together (npm-delta.js), DELTAS_AT_ONCE at a time. Each read as
// GET delta reads it, with the reader's access to its package, which is
// checked again once it is counted: a private one's told only to a reader
// who may still read it, none told to one whose session is gone.
const MAX_ASKED_DELTAS = 50
const DELTAS_AT_ONCE = 2
async function handleNpmDeltas(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, params: URLSearchParams): Promise<void> {
  if (req.method !== 'GET') { send405(res, 'GET'); return }
  let asked: unknown = null
  try { asked = JSON.parse(params.get('versions') ?? '') } catch {}
  if (!Array.isArray(asked) || asked.length === 0 || asked.length > MAX_ASKED_DELTAS || !asked.every(item => Array.isArray(item) && item.length === 3
    && isNpmPackageName(item[0]) && isNpmPackageSpec(item[1]) && (item[2] === '(empty)' || isNpmPackageSpec(item[2])))) { sendJson(res, 400, { error: 'bad-package' }); return }
  const versions = asked as [string, string, string][]
  const reader = await npmReader(deps, cookie, [...new Set(versions.map(([name]) => name))], { handed: true })
  if (reader == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  const controller = new AbortController()
  res.once('close', () => { if (!res.writableEnded) controller.abort() })
  res.setTimeout(NPM_RESPONSE_IDLE_MS, () => res.destroy())
  const kept = npmDeltaStore<NpmDelta>(deps.db, deps.config.debug), keptVersions = npmVersionStore(deps.db, deps.config.debug)
  const out = openLines(res)
  let stopped = false
  await eachOf(versions, DELTAS_AT_ONCE, async ([name, version, otherVersion]) => {
    if (stopped || controller.signal.aborted) return
    const asOne = { name, version, otherVersion }
    let isPrivate = false, line: Record<string, unknown>
    try {
      const privileged = canReadPrivateNpm(reader, name)
      const together = otherVersion === '(empty)' ? keptVersions : readTogether(keptVersions, [{ name, version }, { name, version: otherVersion }])
      const [doc, old] = await Promise.all([readNpmVersion(name, version, privileged, controller.signal, together).then(found),
        otherVersion === '(empty)' ? null : readNpmVersion(name, otherVersion, privileged, controller.signal, together).then(found)])
      isPrivate = doc.private || old?.private === true
      const side = (of: NpmVersionDocument) => ({ integrity: of.dist.integrity, files: async () => {
        const load = loadNpmFiles(of)
        try { return await load.result } finally { load.release() }
      } })
      line = { ...asOne, ...await npmDelta(old ? side(old) : null, side(doc), kept) }
    } catch (err) {
      if (controller.signal.aborted) return
      if (!(err instanceof NpmPackageError)) console.warn('managed: a package delta failed:', err)
      line = err instanceof NpmPackageError ? { ...asOne, error: err.message, status: err.status } : { ...asOne, error: 'delta-failed', status: 500 }
    }
    // A reader who lost their session, or their access to a private one,
    // while it was counted, is told nothing of it.
    const current = await npmReader(deps, cookie, isPrivate ? [name] : [])
    if (current == null) { stopped = true; out.cut(); return }
    if (isPrivate && !canReadPrivateNpm(current, name)) line = { ...asOne, error: 'package-not-found', status: 404 }
    if (!stopped && !await out.write(line)) stopped = true
  })
  if (!stopped) await out.end()
}

// GET /api/npm/{package,versions,download,stats,advisories,tags,socket,provenance,pretty,rename-diff,type-only,risk,comparison}. Only readers with private access
// (canReadPrivateNpm) can be answered from the server's npm token; the rest get
// what the registry answers anonymously, every time (see npm-packages.ts).
// Access is checked again after the registry's answer.
async function handleNpm(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, path: string, params: URLSearchParams): Promise<void> {
  if (req.method !== 'GET') { send405(res, 'GET'); return }
  const name = params.get('name'), spec = params.get('version') ?? 'latest'
  // All but the package's own (its versions, figures and advisories) are a version's.
  const versioned = path !== NPM_VERSIONS_PATH && path !== NPM_STATS_PATH && path !== NPM_ADVISORIES_PATH
  const otherSpec = params.get('otherVersion') ?? ''
  // The package a comparison's other side is a version of, another where Review compares a dependency replaced.
  const otherName = path === NPM_COMPARISON_PATH ? params.get('otherName') ?? name : name
  if (!isNpmPackageName(name) || !isNpmPackageName(otherName) || (versioned && !isNpmPackageSpec(spec)) || ((path === NPM_RENAME_DIFF_PATH || path === NPM_TYPE_ONLY_PATH) && !isNpmPackageSpec(otherSpec))
    || (path === NPM_PRETTY_PATH && otherSpec !== '' && !isNpmPackageSpec(otherSpec))
    || (path === NPM_RISK_PATH && otherSpec !== '' && otherSpec !== '(empty)' && !isNpmPackageSpec(otherSpec))
    || ((path === NPM_COMPARISON_PATH || path === NPM_DELTA_PATH) && otherSpec !== '(empty)' && !isNpmPackageSpec(otherSpec))) {
    sendJson(res, 400, { error: 'bad-package' }); return
  }
  const diffed = path === NPM_RENAME_DIFF_PATH && params.has('path') ? renameDiffRequest(params) : null
  if (path === NPM_RENAME_DIFF_PATH && params.has('path') && !diffed) { sendJson(res, 400, { error: 'bad-file' }); return }
  const reader = await npmReader(deps, cookie, otherName === name ? [name] : [name, otherName], { handed: true })
  if (reader == null) { sendJson(res, 401, { error: 'unauthenticated' }); return }
  const controller = new AbortController()
  const onClose = () => { if (!res.writableEnded) controller.abort() }
  res.on('close', onClose)
  // A reader who lost their session, or their private access to an answer
  // that needed it, while the registry was asked gets nothing.
  const recheck = async (isPrivate: boolean) => {
    const current = await npmReader(deps, cookie, isPrivate ? [name] : [])
    if (current == null) { sendJson(res, 401, { error: 'unauthenticated' }); return false }
    if (isPrivate && !canReadPrivateNpm(current, name)) { sendJson(res, 404, { error: 'package-not-found' }); return false }
    return !res.destroyed
  }
  const reply = async (isPrivate: boolean, body: Record<string, unknown>) => { if (await recheck(isPrivate)) sendJson(res, 200, body) }
  // The reader's GitHub token, for GitHub's rate limits and never for what it
  // shows: asked for once, and only where an answer isn't kept (npm-insights.ts).
  let token: Promise<string | null> | undefined
  const githubToken = () => token ??= ensureUserAccessToken(deps.config, deps.db, reader.userId, Date.now()).catch(() => null)
  const privileged = canReadPrivateNpm(reader, name)
  // Public versions' documents, kept in the database (npm-kept.ts), as
  // repository risk scans keep them: an exact version's, read on every view,
  // asked of npm once a day.
  const keptVersions = npmVersionStore(deps.db, deps.config.debug)
  // The latest version, read once a request: the package's figures and
  // advisories go by the repository it names.
  let latest: Promise<NpmVersionDocument | null> | undefined
  const latestDoc = () => latest ??= readNpmVersion(name, 'latest', privileged, controller.signal, keptVersions)
  const advisoryOptions = npmAdvisoryOptions(deps, githubToken, latestDoc)
  // The figures of the repository the latest version names, noted as its
  // repository for npmKnown; null where it names none, or they can't be had.
  const githubFigures = (doc: NpmVersionDocument) => {
    const repo = githubRepoOf(doc)
    npmLatestRepo(name, repo)
    return repo === null ? null : npmGithubStats(repo, githubToken).catch(() => null)
  }
  try {
    // With whether a visible team lists its scope (`teamScoped`): its own
    // releases, which the viewer doesn't flag as just published.
    if (path === NPM_VERSIONS_PATH) {
      const scope = npmPackageScope(name)
      const [versions, teamScoped] = await Promise.all([readNpmVersions(name, privileged, controller.signal, { times: true }),
        scope !== null && deps.db.hasTeamNpmScope(scope)])
      await reply(found(versions).private, { ...versions, teamScoped })
      return
    }
    // Across every published version, as the version list has them, which
    // each advisory's `affected` indexes; those of the repository its latest
    // version names, where GitHub says it is public, asked with the reader's
    // GitHub token, its listing kept as bundle advisories keep it.
    if (path === NPM_ADVISORIES_PATH) {
      const versions = found(await readNpmVersions(name, privileged, controller.signal))
      await reply(versions.private, { name, ...await npmAdvisories(name, versions.versions, advisoryOptions) })
      return
    }
    // The package's, with the repository its latest version names; either
    // is null where it can't be had.
    if (path === NPM_STATS_PATH) {
      // npm's downloads, which need nothing of the version, are asked at once;
      // none is answered before the package's access is.
      const downloadsAsked = npmDownloads(name).catch(() => null)
      const doc = found(await latestDoc())
      const [downloads, github] = await Promise.all([downloadsAsked, githubFigures(doc)])
      await reply(doc.private, { name, downloads, github })
      return
    }
    // The version it is compared with, where its route names one, read
    // beside it, the two read of those kept at once.
    const against: [string, string, boolean] | null = (path === NPM_RISK_PATH && otherSpec !== '' && otherSpec !== '(empty)') || (path === NPM_DELTA_PATH && otherSpec !== '(empty)')
      || ((path === NPM_TYPE_ONLY_PATH || path === NPM_RENAME_DIFF_PATH || (path === NPM_PRETTY_PATH && !params.has('path'))) && otherSpec !== '')
      ? [name, otherSpec, privileged]
      : path === NPM_COMPARISON_PATH && otherSpec !== '(empty)' ? [otherName, otherSpec, canReadPrivateNpm(reader, otherName)] : null
    const keptTogether = against ? readTogether(keptVersions, [{ name, version: spec }, { name: against[0], version: against[1] }]) : keptVersions
    const otherAsked = against && readNpmVersion(against[0], against[1], against[2], controller.signal, keptTogether)
    otherAsked?.catch(() => {})
    const otherDoc = async () => found(await otherAsked!)
    const doc = found(await readNpmVersion(name, spec, privileged, controller.signal, keptTogether))
    if (spec === 'latest') latest = Promise.resolve(doc)
    const repo = githubRepoOf(doc), sha = bundleCommitHash(doc.manifest['gitHead'])
    // What the viewer asks about a version beside its files, by its route,
    // and asks for meanwhile below. Its publish commit's tags, where its
    // repository is public on GitHub and the reader has a token to ask with.
    // Socket's report, asked only where npm answers for the version without a
    // token: a private package's name never leaves for Socket. npm's
    // provenance, asked only where its version says npm keeps one, and npm
    // answers for the version without a token.
    const tagsOf = () => repo === null || sha === null ? Promise.resolve([]) : npmCommitTags(repo, sha, doc.version, githubToken)
    const socketOf = () => doc.private ? Promise.resolve(null) : npmSocketReport(name, doc.version)
    const provenanceOf = () => doc.private || doc.manifest['provenance'] !== true ? Promise.resolve(null) : npmProvenance(name, doc.version, doc.dist.integrity)
    // None where tags or Socket's report can't be had; a failure to have
    // provenance is answered as one, for the viewer to ask again.
    if (path === NPM_TAGS_PATH) { await reply(doc.private, { name, version: doc.version, tags: await tagsOf().catch(() => []) }); return }
    if (path === NPM_SOCKET_PATH) { await reply(doc.private, { name, version: doc.version, socket: await socketOf().catch(() => null) }); return }
    // What calls for a look at the version, as risk tells it (npm-risk.ts),
    // against `otherVersion` where given, as Compare asks, else against the
    // one risk picks of its versions, as the Overview asks; trusted however
    // new and however few download it where a team lists its scope, its own
    // packages, as a new dependency on a package of such a scope is.
    if (path === NPM_RISK_PATH) {
      const old = otherSpec === '' || otherSpec === '(empty)' ? null : await otherDoc()
      const scope = npmPackageScope(name)
      const teamScoped = scope !== null && await deps.db.hasTeamNpmScope(scope)
      const assessment = await npmRisk(doc, otherSpec === '' ? 'pick' : old, { db: deps.db, npmCache: deps.npmCacheStorage, debug: deps.config.debug, teamScoped, fromEmpty: otherSpec === '(empty)',
        ownScope: listed => deps.db.hasTeamNpmScope(listed), privileged, signal: controller.signal })
      // What it tells is read of both versions: private where either is.
      res.setTimeout(NPM_RESPONSE_IDLE_MS, () => res.destroy())
      await reply(doc.private || old?.private === true, { ...assessment })
      return
    }
    if (path === NPM_PROVENANCE_PATH) { await reply(doc.private, { name, version: doc.version, provenance: await provenanceOf() }); return }
    // The lines it changes against `otherVersion`, or `(empty)`, its whole
    // package's, and those but for declaration files changed in types alone
    // (npm-delta.ts), as a list of versions wanting reviews tells them.
    if (path === NPM_DELTA_PATH) {
      const old = otherSpec === '(empty)' ? null : await otherDoc()
      res.setTimeout(NPM_RESPONSE_IDLE_MS, () => res.destroy())
      const side = (version: NpmVersionDocument) => ({ integrity: version.dist.integrity, files: async () => {
        const load = loadNpmFiles(version)
        try { return await load.result } finally { load.release() }
      } })
      const delta = await npmDelta(old ? side(old) : null, side(doc), npmDeltaStore<NpmDelta>(deps.db, deps.config.debug))
      await reply(doc.private || old?.private === true, { name, version: doc.version, otherVersion: old?.version ?? null, ...delta })
      return
    }
    // Its files paired with those of `otherVersion` (of `otherName`, else the
    // same package), as Compare and Review pair them, with what their
    // Overview reads beside them (comparison.ts): the version shown against
    // the one compared with, or `(empty)`, none, as Review reads a first
    // version. Read of both, each package's access checked again once worked out.
    if (path === NPM_COMPARISON_PATH) {
      const old = otherSpec === '(empty)' ? null : await otherDoc()
      res.setTimeout(NPM_RESPONSE_IDLE_MS, () => res.destroy())
      const loads = [doc, ...old ? [old] : []].map(loadNpmFiles)
      let body
      try {
        const [files, oldFiles] = await Promise.all(loads.map(load => load.result))
        body = await comparisonBody(old ? npmComparedSide(old.dist.integrity, oldFiles!) : emptySide(), npmComparedSide(doc.dist.integrity, files!))
      } finally { for (const load of loads) load.release() }
      const current = await npmReader(deps, cookie, otherName === name ? [name] : [name, otherName])
      if (current == null) { body.stream.destroy(); sendJson(res, 401, { error: 'unauthenticated' }); return }
      if ((doc.private && !canReadPrivateNpm(current, name)) || (old?.private && !canReadPrivateNpm(current, otherName))) {
        body.stream.destroy(); sendJson(res, 404, { error: 'package-not-found' }); return
      }
      if (!res.destroyed) await sendEncoded(req, res, body, 'application/json')
      return
    }
    // Every one of its files that needs it pretty-printed (pretty-print.ts
    // npmAll), or, against another version, the files that changed between
    // them, both sides' (compared), a line each as it is formatted, or found
    // kept for a public version; its files read before anything is answered.
    // A reader who lost their session, or their access, meanwhile has the
    // rest cut short.
    if (path === NPM_PRETTY_PATH && params.has('path')) {
      // One of its files pretty-printed, as one of a bundle's is.
      const file = prettyRequest(params)
      if (!file) { sendJson(res, 400, { error: 'bad-file' }); return }
      if (!deps.prettyCache) { sendJson(res, 503, { error: 'unavailable' }); return }
      const copy = await deps.prettyCache.npm(doc, file)
      if (!(await recheck(doc.private))) { copy.stream.destroy(); return }
      await sendEncoded(req, res, copy, 'text/plain; charset=utf-8', prettySource(file))
      return
    }
    // Against another version, the pairs of its files that changed that the
    // viewer diffs with renamed names hidden (rename-diff.ts renamedPairs), a
    // line each as it is worked out, as Compare's pretty-printed files are;
    // and those that changed in types alone (type-only.ts).
    if (path === NPM_PRETTY_PATH || path === NPM_TYPE_ONLY_PATH || (path === NPM_RENAME_DIFF_PATH && !diffed)) {
      if (!deps.prettyCache) { sendJson(res, 503, { error: 'unavailable' }); return }
      const other = otherSpec === '' ? null : await otherDoc()
      const sides = other && await deps.prettyCache.npmSides(doc, other)
      const lines = path === NPM_RENAME_DIFF_PATH ? renamedPairs(sides!, !doc.private && !other!.private)
        : path === NPM_TYPE_ONLY_PATH ? typeOnlyFiles(sides!) : sides ? compared(sides) : await deps.prettyCache.npmAll(doc)
      const isPrivate = doc.private || other?.private === true
      if (!(await recheck(isPrivate))) return
      res.setTimeout(NPM_RESPONSE_IDLE_MS, () => res.destroy())
      await sendLines(res, lines, async () => {
        const current = await npmReader(deps, cookie, isPrivate ? [name] : [])
        return current != null && (!isPrivate || canReadPrivateNpm(current, name))
      })
      return
    }
    // One of its JavaScript files diffed with another version's, both
    // pretty-printed, renamed names hidden (rename-diff.ts).
    if (diffed) {
      const { prettyCache } = deps
      if (!prettyCache) { sendJson(res, 503, { error: 'unavailable' }); return }
      const other = await otherDoc()
      const diff = await renameDiffOf(diffed, async () => [await prettyText(await prettyCache.npm(doc, diffed.base)),
        await prettyText(await prettyCache.npm(other, diffed.other))], !doc.private && !other.private)
      if (!(await recheck(doc.private || other.private))) { diff.stream.destroy(); return }
      res.setTimeout(NPM_RESPONSE_IDLE_MS, () => res.destroy())
      await sendEncoded(req, res, diff, 'application/json')
      return
    }
    // The load stays held until this response is written or abandoned, and
    // a reader who stops reading it gives it up after a while. One already
    // gone takes none, as its close has passed.
    if (res.destroyed) return
    const download = path === NPM_DOWNLOAD_PATH
    // A version's files take longest to load: what the viewer asks for beside
    // them is asked for meanwhile, so that what is answered by the time they
    // are encoded comes with them (npmKnown), and the rest is on its way when
    // the viewer asks. Nothing waits on it, and a failure is left for the
    // viewer's own request to meet. Its whole document, read for its
    // advisories' version list and the time each version was published
    // (npmPublishTime), is read only where registry reads leave room for
    // readers'; a public version's time is then kept in the database
    // (npm-kept.ts), to come with the version on any instance.
    const published = download ? undefined : npmPublishTime(doc, npmPublishTimeStore(deps.db, deps.config.debug))
    if (published) {
      const quiet = (asked: Promise<unknown>) => { asked.catch(() => {}) }
      quiet(npmDownloads(name))
      quiet(latestDoc().then(newest => newest && githubFigures(newest)))
      quiet(readNpmVersions(name, privileged, controller.signal, { times: true, spare: true })
        .then(versions => versions && Promise.all([published.keep(), npmAdvisories(name, versions.versions, advisoryOptions)])))
      quiet(tagsOf())
      quiet(socketOf())
      quiet(provenanceOf())
    }
    const load = published ? loadNpmPackageBody(doc, () => npmKnown(name, doc.version, doc.private, repo, sha), published.read) : loadNpmTarball(doc)
    res.once('close', load.release)
    const bytes = await load.result
    if (!(await recheck(doc.private))) return
    res.setTimeout(NPM_RESPONSE_IDLE_MS, () => res.destroy())
    res.writeHead(200, {
      ...download
        ? { 'content-type': 'application/gzip', 'content-disposition': attachmentDisposition(npmTarballFilename(doc.name, doc.version)) }
        : { 'content-type': 'application/json', 'content-encoding': 'br' },
      'content-length': String(bytes.byteLength), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
    })
    writeResponse(res, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  } catch (err) {
    if (err instanceof NpmPackageError || err instanceof PrettyError) { if (!res.headersSent && !res.destroyed) sendJson(res, err.status, { error: err.message }); return }
    if (err instanceof NpmRiskError) { if (!res.headersSent && !res.destroyed) sendRiskError(res, err); return }
    if (controller.signal.aborted) return
    throw err
  } finally {
    res.off('close', onClose)
  }
}

async function handleWorkspaceShare(req: IncomingMessage, res: ServerResponse, deps: ManagedHttpDeps, cookie: string | undefined, teamId: string, id?: string) {
  if (!deps.config.allowShare) { sendJson(res, 404, { error: 'sharing-disabled' }); return }
  const method = req.method ?? 'GET'
  const allowed = id ? ['PATCH', 'DELETE'] : ['GET', 'POST', 'DELETE']
  if (!allowed.includes(method)) { send405(res, allowed.join(', ')); return }
  const s = method === 'GET' ? await readSession(deps.config, deps.db, cookie, Date.now(), { handed: true }) : await checkMutation(req, res, deps, cookie, { handed: true })
  if (!s) { if (method === 'GET') sendJson(res, 401, { error: 'unauthenticated' }); return }
  if (!requireManageRole(res, s.user)) return
  const { db } = deps
  if (method === 'GET') {
    const shares = await db.listWorkspaceShares(s.session.id, Date.now(), teamId)
    sendJson(res, shares ? 200 : 404, shares ? { shares } : { error: 'no-team' }); return
  }
  let body
  if (method === 'POST' || method === 'PATCH') {
    try { body = await readJsonBody(req) } catch { sendJson(res, 400, { error: 'bad-body' }); return }
  }
  const permissions = parseTeamUserPermissions(body), token = method === 'POST' ? randomToken() : ''
  const shareId = id ?? hashToken(token)
  const ok = method === 'POST' ? await db.createWorkspaceShare(s.session.id, Date.now(), teamId, shareId, permissions)
    : method === 'PATCH' ? await db.updateWorkspaceShare(s.session.id, Date.now(), teamId, shareId, permissions)
    : await db.revokeWorkspaceShares(s.session.id, Date.now(), teamId, id)
  if (!ok) { sendJson(res, 404, { error: 'no-share' }); return }
  const team = await db.getTeam(teamId)
  if (!team) { sendJson(res, 404, { error: 'no-team' }); return }
  const action = method === 'POST' ? 'created a public link' : method === 'PATCH' ? 'updated a public link' : id ? 'revoked a public link' : 'revoked public links'
  const access = method === 'DELETE' ? '' : ` (dependencies: ${permissions.dependencies ? 'on' : 'off'}, security: ${permissions.security ? 'on' : 'off'})`
  await activity(deps, s.user, 'access', `${action} for team ${team.name}${access}`)
  sendJson(res, 200, method === 'POST' ? { id: shareId, path: `/team/${team.slug}#public=${shareId.slice(0, 8)}.${token}` } : { ok: true })
}

export function createManagedRequestHandler(deps: ManagedHttpDeps): Handler {
  const { config, db, avatarStore, isShuttingDown, track } = deps
  const repositoryDiscovery = new RepositoryDiscovery(config)
  // Kept reads' prunes run behind their writes: tracked, so the database
  // outlives them, and on serverless kept alive past the answer.
  ownKeptPrunes(db, prune => { track(prune); deps.waitUntil?.(prune) })

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'
    const cookie = req.headers.cookie
    const viewing = viewToken(config, cookie) != null

    if (req.headers['x-deepview-share'] !== undefined || path.startsWith('/api/shares/')) {
      await handlePublicWorkspace(req, res, deps, url); return
    }

    // Public mode probe — lets a client detect the managed protocol up front.
    // It also sends the session, sparing the client's GET /api/auth/session;
    // a failed read leaves that request to the client, never failing the probe.
    if (path === CONFIG_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const info = deps.serverInfo ?? { mode: 'managed', managed: { loginPath: LOGIN_PATH, cookieName: config.sessionCookieName } }
      const current = await currentSession(config, db, cookie).catch((err) => { console.warn('managed: config session read failed:', err); return null })
      sendJson(res, 200, { ...info, ...(config.githubNewIssueLabels ? { githubNewIssueLabels: config.githubNewIssueLabels } : {}),
        managed: { ...info.managed, ...(config.allowShare ? { allowShare: true } : {}), ...(deps.uploadStore ? {
          uploadChunkBytes: UPLOAD_CHUNK_BYTES, uploadMaxBytes: { reports: config.maxReportBytes, bundles: config.maxBundleBytes },
        } : {}) }, ...(current ? { session: current.body } : {}) }, current?.headers)
      return
    }
    if (viewing && underPrefix(path, VIEW_PREFIXES) && !viewAllows(method, path)) { sendViewOnly(res); return }
    // OAuth: start → redirect to GitHub with the CSRF state cookie.
    if (path === LOGIN_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const { location, setCookie } = buildLoginRedirect(config)
      res.writeHead(302, { location, 'set-cookie': setCookie, 'cache-control': 'no-store' })
      res.end()
      return
    }
    // OAuth: callback (the GitHub hook) → mint a session, land on the app.
    if (path === CALLBACK_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      try {
        if (isLinkOAuthCallback(config, url.searchParams, cookie)) {
          if (viewing) { sendViewOnly(res); return }
          const s = await readWorkspaceSession(res, deps, cookie)
          if (!s) return
          const result = await linkOAuthCallback(config, db, s.session, url.searchParams, cookie, { avatarStore })
          if (result.linked != null) await activity(deps, s.user, 'access', `linked GitHub account @${result.linked}`)
          res.writeHead(302, { location: result.location, 'set-cookie': result.setCookie, 'cache-control': 'no-store' })
          res.end(); return
        }
        if (isIssueOAuthCallback(config, url.searchParams, cookie)) {
          if (viewing) { sendViewOnly(res); return }
          const s = await readWorkspaceSession(res, deps, cookie)
          if (!s) return
          const result = await issueOAuthCallback(config, db, s.session, url.searchParams, cookie)
          res.writeHead(302, { location: result.location, 'set-cookie': result.setCookie, 'cache-control': 'no-store' })
          res.end(); return
        }
        const result = await handleCallback(url.searchParams, cookie, { config, db, avatarStore })
        // A new sign-in never resumes an earlier view.
        const setCookies = viewing ? [...result.setCookies, clearViewCookie(config)] : result.setCookies
        res.writeHead(302, { location: result.location, 'set-cookie': setCookies, 'cache-control': 'no-store' })
        res.end()
      } catch (err) {
        if (err instanceof OAuthError) sendJson(res, err.status, { error: err.message })
        else throw err
      }
      return
    }
    if (path === ISSUE_LOGIN_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = await readWorkspaceSession(res, deps, cookie)
      if (!s) return
      const result = issueLoginRedirect(config, s.session)
      res.writeHead(302, { location: result.location, 'set-cookie': result.setCookie, 'cache-control': 'no-store' })
      res.end(); return
    }
    if (path === LINK_LOGIN_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = await readWorkspaceSession(res, deps, cookie)
      if (!s) return
      const result = linkLoginRedirect(config, s.session)
      res.writeHead(302, { location: result.location, 'set-cookie': result.setCookie, 'cache-control': 'no-store' })
      res.end(); return
    }
    if (path === PROFILE_PATH) { await handleProfile(req, res, deps, cookie); return }
    const unlink = /^\/api\/auth\/profile\/accounts\/([a-f\d-]{36})$/iu.exec(path)
    if (unlink) { await handleUnlinkAccount(req, res, deps, cookie, unlink[1]!); return }
    if (path === SESSION_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const { body, headers } = await currentSession(config, db, cookie)
      if (body == null) { sendJson(res, 401, { error: 'unauthenticated' }, headers); return }
      sendJson(res, 200, body, headers)
      return
    }
    if (path === VIEW_AS_PATH) { await handleViewAs(req, res, deps, cookie); return }
    // Authentication is not workspace access. Keep bootstrap/session/logout
    // available so blocked accounts can see their role and sign out, but deny
    // every managed data route before reading bodies or looking up resources.
    const managedDataPath = underPrefix(path, MANAGED_DATA_PREFIXES)
    const workspaceSession = managedDataPath ? await readWorkspaceSession(res, deps, cookie) : null
    if (managedDataPath && !workspaceSession) return
    // What it read, for the handler's own first read to take.
    if (workspaceSession) handOverSession(cookie, workspaceSession)
    const issueRoute = /^\/api\/teams\/([^/]+)\/issues$/u.exec(path)
    if (issueRoute) {
      await handleWorkspaceIssue(req, res, deps, cookie, decodeURIComponent(issueRoute[1]!), url.searchParams); return
    }
    const deduplication = /^\/api\/admin\/deduplication(?:\/([a-f\d-]{36}))?$/iu.exec(path)
    if (deduplication) { await handleDeduplication(req, res, deps, cookie, deduplication[1]); return }
    const repositoryAliases = /^\/api\/admin\/repositories\/aliases(?:\/([a-f\d-]{36}))?$/iu.exec(path)
    if (repositoryAliases) { await handleRepositoryAliases(req, res, deps, cookie, repositoryAliases[1]); return }
    if (path === '/api/admin/repositories/resolve') { await handleRepositorySuggestion(req, res, deps, cookie); return }
    if (path === '/api/admin/links') {
      if (!config.allowShare) { sendJson(res, 404, { error: 'sharing-disabled' }); return }
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = workspaceSession!
      if (!requireManageRole(res, s.user)) return
      const shares = await db.listManagedWorkspaceShares(s.session.id, Date.now())
      sendJson(res, shares ? 200 : 403, shares ? { shares } : { error: 'forbidden' }); return
    }
    const shareRoute = /^\/api\/teams\/([^/]+)\/share(?:\/([A-Za-z0-9_-]{43}))?$/u.exec(path)
    if (shareRoute) {
      await handleWorkspaceShare(req, res, deps, cookie, shareRoute[1]!, shareRoute[2]); return
    }
    if (path === '/api/admin/uploads/key') { await handleUploadKey(req, res, deps, cookie); return }
    if (path.startsWith('/api/admin/uploads/')) { await handleUploadPart(req, res, deps, cookie, path); return }
    // Cached avatar by user id, served same-origin (the page CSP forbids the
    // github CDN). The id in the path keys the browser cache per user, so a user
    // switch never serves a stale avatar. Workspace access is required. A user's
    // is that of the account chosen on their profile; `own` asks for the
    // sign-in account's. A linked account's is served by its own id.
    if (path.startsWith(AVATAR_PREFIX)) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const id = path.slice(AVATAR_PREFIX.length)
      if (AGENT_AVATARS.has(id) && AGENT_AVATAR.test(id)) { await serveAgentAvatar(res, avatarStore, id); return }
      await serveAvatar(res, avatarStore, id, url.searchParams.has('own') ? id : await db.getAvatarKey(id))
      return
    }
    // Admin: list users (admin-only).
    if (path === ADMIN_HISTORY_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleHistory(res, deps, cookie, url.searchParams); return
    }
    if (path === ADMIN_USERS_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      if (workspaceSession!.user.role !== 'admin') { sendJson(res, 403, { error: 'forbidden' }); return }
      sendJson(res, 200, { users: await db.listUsers() })
      return
    }
    if (path === ADMIN_SCAN_MODELS_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleListModels(res, deps, cookie); return
    }
    if (path === SET_ROLE_PATH) { await handleSetRole(req, res, deps, cookie); return }
    if (path === REPO_IMPACT_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryImpact(req, res, deps, cookie); return
    }
    if (path === REMOVE_REPO_PATH) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleRemoveRepository(req, res, deps, cookie); return
    }
    if (path === REPO_RISK_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryRisk(res, deps, cookie, url.searchParams); return
    }
    if (path === BROWSABLE_REPOS_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleBrowsableRepositories(res, deps, cookie); return
    }
    if (path === REPO_REFS_PATH || path === REPO_CONTENTS_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryBrowser(res, deps, cookie, url.searchParams, path === REPO_REFS_PATH); return
    }
    if (path === REPO_CODE_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryCode(res, deps, cookie, url.searchParams); return
    }
    if (path === REPO_HISTORY_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryHistory(res, deps, cookie, url.searchParams); return
    }
    if (path === REPO_CHANGES_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryChanges(res, deps, cookie, url.searchParams); return
    }
    if (path === REPO_TREE_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryTree(res, deps, cookie, url.searchParams); return
    }
    if (path === REPO_ISSUES_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryIssues(res, deps, cookie, url.searchParams); return
    }
    if (path === REPO_AGENTS_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryAgents(res, deps, cookie, url.searchParams); return
    }
    if (path === REPO_ITEM_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryItem(res, deps, cookie, url.searchParams); return
    }
    if (path === REPO_PULL_DEPENDENCIES_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryPullDependencies(res, deps, cookie, url.searchParams); return
    }
    if (path === REPO_BRANCH_DEPENDENCIES_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryBranchDependencies(res, deps, cookie, url.searchParams); return
    }
    if (path === REPO_LOCKFILES_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryLockfiles(res, deps, cookie, url.searchParams); return
    }
    if (path === REPO_PULSE_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryPulse(res, deps, cookie, url.searchParams); return
    }
    if (path === REPO_PULSE_ITEMS_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleRepositoryPulseItems(res, deps, cookie, url.searchParams); return
    }
    if (path === ADMIN_REPOS_PATH) { await handleListRepositories(req, res, deps, cookie, repositoryDiscovery); return }
    if (path === SELECT_REPO_PATH) { await handleSelectRepository(req, res, deps, cookie); return }
    if (path === REPO_DEPENDENCY_REVIEW_PATH) { await handleRepositoryDependencyReview(req, res, deps, cookie); return }
    if (path === ADD_PUBLIC_REPO_PATH) { await handleAddPublicRepository(req, res, deps, cookie); return }
    if (path === CONNECT_REPO_APP_PATH) { await handleConnectRepositoryApp(req, res, deps, cookie); return }
    // Reports: list / upload on the exact path, download / delete per-id on the
    // prefix. Method-dispatched here since each path carries two verbs.
    if (path === ADMIN_REPORTS_PATH) {
      if (method === 'GET') { await handleListReports(res, deps, workspaceSession!.session); return }
      if (method === 'POST') { await handleUploadReport(req, res, deps, cookie); return }
      send405(res, 'GET, POST'); return
    }
    // set-repo is an exact sub-path; check it before the per-id prefix (a report
    // id is a uuid, so it never collides with "set-repo").
    if (path === REPORT_SET_REPO_PATH) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleSetReportRepo(req, res, deps, cookie); return
    }
    if (path === REPORT_SET_VISIBLE_PATH) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleSetReportVisible(req, res, deps, cookie); return
    }
    if (path === '/api/admin/reports/finding-ids') {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleImportFindingIds(res, deps, cookie, url.searchParams); return
    }
    const importTriage = /^\/api\/admin\/reports\/([a-f\d-]{36})\/import-triage$/iu.exec(path)
    if (importTriage) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleImportTriage(req, res, deps, cookie, importTriage[1]!); return
    }
    const reportLocation = /^\/api\/admin\/reports\/([a-f\d-]{36})\/location$/iu.exec(path)
    if (reportLocation) { await handleReportLocationSuggestion(req, res, deps, cookie, reportLocation[1]!); return }
    if (path.startsWith(REPORT_PREFIX)) {
      const id = path.slice(REPORT_PREFIX.length)
      if (method === 'GET') { await handleGetReport(res, deps, cookie, id); return }
      if (method === 'DELETE') { await handleDeleteReport(req, res, deps, cookie, id); return }
      send405(res, 'GET, DELETE'); return
    }
    // Bundles: list / upload on the exact path, download / delete per-id on the
    // prefix (same shape as reports).
    const bundleAdvisories = /^\/api\/bundles\/([a-f\d-]{36})\/advisories$/iu.exec(path)
    if (bundleAdvisories) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleBundleAdvisories(res, deps, workspaceSession!.session, bundleAdvisories[1]!, url.searchParams.get('team'), url.searchParams.get('reason') ?? '', url.searchParams.get('repoAdvisories') === 'true', url.searchParams.get('details') === 'true')
      return
    }
    const bundleRead = /^\/api\/bundles\/([a-f\d-]{36})\/(metadata|contents|download|pretty|rename-diff|type-only|comparison)$/iu.exec(path)
    if (bundleRead) {
      const id = bundleRead[1]!, part = bundleRead[2]!, { session } = workspaceSession!, { bundleCache, prettyCache } = deps
      if (part === 'comparison') {
        if (method !== 'GET') { send405(res, 'GET'); return }
        await handleBundleComparison(req, res, deps, session, id, url.searchParams); return
      }
      if (part === 'rename-diff' || part === 'type-only' || (part === 'pretty' && url.searchParams.has('other'))) {
        if (method !== 'GET') { send405(res, 'GET'); return }
        if (part === 'rename-diff' && url.searchParams.has('path')) { await handleBundleRenameDiff(req, res, deps, session, id, url.searchParams); return }
        // The pairs a scoped Compare diffs, of the files it compares within its scope.
        const [linesOf, scope] = part === 'pretty' ? [compared, ''] : [part === 'type-only' ? typeOnlyFiles : renamedPairs, url.searchParams.get('scope') ?? '']
        await handleBundleChanges(res, deps, session, id, url.searchParams.get('other') ?? '', async (cache, base, other) => linesOf(await cache.bundleSides(base, other, scope))); return
      }
      if (method !== 'GET' && method !== 'HEAD') { send405(res, 'GET, HEAD'); return }
      if (part === 'download') { await handleGetBundle(req, res, deps, session, id); return }
      if (part !== 'pretty') { await handleBundleCache(req, res, deps, session, id, bundleCache && (rec => bundleCache.open(rec, part as BundleCachePart))); return }
      const file = prettyRequest(url.searchParams)
      if (!file) { sendJson(res, 400, { error: 'bad-file' }); return }
      await handleBundleCache(req, res, deps, session, id, prettyCache && (rec => prettyCache.bundle(rec, file)), 'text/plain; charset=utf-8', prettySource(file))
      return
    }
    if (path === BUNDLE_CREATE_PATH) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleCreateBundle(req, res, deps, cookie); return
    }
    if (path === ADMIN_BUNDLES_PATH) {
      if (method === 'GET') { await handleListBundles(res, deps, workspaceSession!.session); return }
      if (method === 'POST') { await handleUploadBundle(req, res, deps, cookie); return }
      send405(res, 'GET, POST'); return
    }
    if (path === BUNDLE_SET_REPO_PATH) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleSetBundleRepo(req, res, deps, cookie); return
    }
    if (path === BUNDLE_SET_VISIBLE_PATH) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleSetBundleVisible(req, res, deps, cookie); return
    }
    if (path.startsWith(BUNDLE_PREFIX)) {
      const id = path.slice(BUNDLE_PREFIX.length)
      if (method === 'GET') { await handleGetBundle(req, res, deps, workspaceSession!.session, id); return }
      if (method === 'DELETE') { await handleDeleteBundle(req, res, deps, cookie, id); return }
      send405(res, 'GET, DELETE'); return
    }
    const teamFeed = /^\/api\/teams\/([^/]+)\/feed$/u.exec(path)
    if (teamFeed || path === '/api/teams/feed') {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = workspaceSession!
      const teamId = teamFeed?.[1] ?? null
      const reportId = url.searchParams.get('reportId')
      if (teamId) await teamSnapshot(db, s.session.id, teamId, reportId)
      await serveUserTeamFeed(res, deps, s.session.id, s.user, teamId, { reportId }); return
    }
    const teamDependencies = /^\/api\/teams\/([^/]+)\/dependencies$/u.exec(path)
    if (teamDependencies) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleTeamDependencies(res, deps, cookie, workspaceSession!, teamDependencies[1]!, url.searchParams); return
    }
    const teamFixes = /^\/api\/teams\/([^/]+)\/fixes$/u.exec(path)
    if (teamFixes) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleWorkspaceFixes(res, deps, cookie, teamFixes[1]!, url.searchParams.get('reportId')); return
    }
    const teamAnnotations = /^\/api\/teams\/([^/]+)\/annotations$/u.exec(path)
    if (teamAnnotations) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const snapshot = await teamSnapshot(db, workspaceSession!.session.id, teamAnnotations[1]!, url.searchParams.get('reportId'))
      const annotations = await loadTeamAnnotations(db, deps.reportStore, snapshot, url.searchParams.get('reportId'))
      await recheckTeam(db, workspaceSession!.session.id, snapshot)
      sendJson(res, 200, annotations); return
    }
    const teamReports = /^\/api\/teams\/([^/]+)\/(reports|trees)$/u.exec(path)
    if (teamReports) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleTeamReports(res, deps, workspaceSession!.session, teamReports[1]!, url.searchParams.get('reportId'), teamReports[2] as 'reports' | 'trees'); return
    }
    if (path === REPORT_QUERY_PATH) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleQueryReports(req, res, deps, cookie); return
    }
    const sourcesRoute = /^\/api\/reports\/([^/]+)\/sources$/u.exec(path)
    if (sourcesRoute) {
      if (method !== 'GET' && method !== 'HEAD') { send405(res, 'GET, HEAD'); return }
      await handleReportSources(req, res, deps, cookie, sourcesRoute[1]!, url.searchParams.get('team')); return
    }
    const commentsRoute = /^\/api\/reports\/([^/]+)\/comments(?:\/([^/]+))?$/u.exec(path)
    if (commentsRoute) {
      await handleReportComments(req, res, deps, cookie, commentsRoute[1]!, commentsRoute[2] ?? null, url.searchParams.get('team')); return
    }
    // Per-finding triage on a viewable report. The '/triage' suffixes are
    // matched before the bare per-id slice below (a report id is a uuid, so it
    // never ends in them) — same trick as REPORT_SET_REPO_PATH above; the
    // longer '/triage/history' goes first.
    if (path.startsWith(MY_REPORT_PREFIX) && path.endsWith(MY_REPORT_TRIAGE_HISTORY_SUFFIX)) {
      const id = path.slice(MY_REPORT_PREFIX.length, -MY_REPORT_TRIAGE_HISTORY_SUFFIX.length)
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleGetReportTriageHistory(res, deps, cookie, id, url.searchParams, url.searchParams.get('team')); return
    }
    if (path.startsWith(MY_REPORT_PREFIX) && path.endsWith(MY_REPORT_TRIAGE_SUFFIX)) {
      const id = path.slice(MY_REPORT_PREFIX.length, -MY_REPORT_TRIAGE_SUFFIX.length)
      if (method === 'GET') { await handleGetReportTriage(res, deps, cookie, id, url.searchParams.get('team')); return }
      if (method === 'POST') { await handleSetReportTriage(req, res, deps, cookie, id, url.searchParams.get('team')); return }
      send405(res, 'GET, POST'); return
    }
    // Individual report previews are reserved for admins/managers.
    if (path.startsWith(MY_REPORT_PREFIX)) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleViewReport(req, res, deps, cookie, path.slice(MY_REPORT_PREFIX.length)); return
    }
    // The signed-in user's own team memberships (any approved user).
    if (path === MY_TEAMS_PATH) {
      if (method !== 'GET') { send405(res, 'GET'); return }
      await handleMyTeams(res, deps, workspaceSession!.session); return
    }
    // Teams: list / create on the exact path; the link mutations are POST-only
    // action sub-paths (each carries its ids in the JSON body).
    if (path === ADMIN_TEAMS_PATH) {
      if (method === 'GET') { await handleListTeams(res, deps, cookie); return }
      if (method === 'POST') { await handleCreateTeam(req, res, deps, cookie); return }
      send405(res, 'GET, POST'); return
    }
    if (path === TEAM_DELETE_PATH || path === TEAM_RENAME_PATH || path === TEAM_SET_HIDDEN_PATH || path === TEAM_SET_REPO_PATH || path === TEAM_REMOVE_REPO_PATH
      || path === TEAM_SET_MEMBER_PATH || path === TEAM_REMOVE_MEMBER_PATH) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      if (path === TEAM_DELETE_PATH) { await handleDeleteTeam(req, res, deps, cookie); return }
      if (path === TEAM_RENAME_PATH) { await handleRenameTeam(req, res, deps, cookie); return }
      if (path === TEAM_SET_HIDDEN_PATH) { await handleSetTeamHidden(req, res, deps, cookie); return }
      if (path === TEAM_SET_REPO_PATH) { await handleSetTeamRepo(req, res, deps, cookie); return }
      if (path === TEAM_REMOVE_REPO_PATH) { await handleRemoveTeamRepo(req, res, deps, cookie); return }
      if (path === TEAM_SET_MEMBER_PATH) { await handleSetTeamMember(req, res, deps, cookie); return }
      await handleRemoveTeamMember(req, res, deps, cookie); return
    }
    if (path === '/api/admin/teams/set-dependency-review') {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleSetTeamDependencyReview(req, res, deps, cookie); return
    }
    if (path === TEAM_SET_NPM_SCOPES_PATH) {
      if (method !== 'POST') { send405(res, 'POST'); return }
      await handleSetTeamNpmScopes(req, res, deps, cookie); return
    }
    if (path === '/api/npm/reviews/latest') {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = workspaceSession!
      const integrity = url.searchParams.get('integrity'), name = url.searchParams.get('package'), version = url.searchParams.get('version')
      if (!isNpmPackageName(name) || !isNpmPackageSpec(version) || !integrity || integrity.length > 1024) {
        sendJson(res, 400, { error: 'bad-review-context' }); return
      }
      const review = await deps.db.getLatestOwnDependencyReview(s.user.id, { ecosystem: 'npm', package: name, version, integrity })
      const visible = await readableNpmReviews(res, deps, cookie, s.user.id, review ? [review] : [], s.user)
      if (visible) sendJson(res, 200, { review: (await withFormatted(deps.reviewedDependencies ?? null, s.user.id, visible))[0] ?? null })
      return
    }
    if (path === '/api/npm/reviews/discard') {
      if (method !== 'POST') { send405(res, 'POST'); return }
      const s = await checkMutation(req, res, deps, cookie, { handed: true })
      if (!s) return
      let body: Record<string, unknown>
      try {
        const raw = await readJsonBody(req, 4096)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bad-body')
        body = raw as Record<string, unknown>
      } catch { sendJson(res, 400, { error: 'bad-body' }); return }
      const id = body['reviewId'], revision = body['revision']
      if (typeof id !== 'string' || !id || id.length > 100 || !Number.isSafeInteger(revision) || Number(revision) < 1) {
        sendJson(res, 400, { error: 'bad-review' }); return
      }
      await deps.db.discardDependencyReview(s.session.id, id, revision as number)
      sendJson(res, 200, { ok: true }); return
    }
    if (path === '/api/npm/reviews/mine') {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = workspaceSession!
      const id = url.searchParams.get('beforeId'), time = url.searchParams.get('beforeTime')
      if ((time !== null || id !== null) && (time === null || !/^\d+$/u.test(time) || !Number.isSafeInteger(Number(time)) || !id || id.length > 100)) {
        sendJson(res, 400, { error: 'bad-review-cursor' }); return
      }
      const page = await deps.db.listOwnDependencyReviews(s.user.id, time !== null && id !== null ? { time: Number(time), id } : null)
      const reviews = await readableNpmReviews(res, deps, cookie, s.user.id, page.reviews, s.user)
      if (reviews) sendJson(res, 200, { ...page, reviews: await withFormatted(deps.reviewedDependencies ?? null, s.user.id, reviews) })
      return
    }
    // Those published to a team, of one who reads them there, as its
    // Dependencies tab lists them, fifty a page.
    if (path === '/api/npm/reviews/team') {
      if (method !== 'GET') { send405(res, 'GET'); return }
      const s = workspaceSession!
      const id = url.searchParams.get('beforeId'), teamId = url.searchParams.get('teamId'), time = url.searchParams.get('beforeTime')
      if (!teamId || teamId.length > 100) { sendJson(res, 400, { error: 'bad-team' }); return }
      if ((time !== null || id !== null) && (time === null || !/^\d+$/u.test(time) || !Number.isSafeInteger(Number(time)) || !id || id.length > 100)) {
        sendJson(res, 400, { error: 'bad-review-cursor' }); return
      }
      const page = await deps.db.listTeamDependencyReviews(teamId, s.user.id, time !== null && id !== null ? { time: Number(time), id } : null)
      if (!page) { sendJson(res, 404, { error: 'no-team' }); return }
      // Its access asked again, as it may have been taken while npm was read.
      const reviews = await readableNpmReviews(res, deps, cookie, s.user.id, page.reviews, s.user, teamId)
      if (reviews) sendJson(res, 200, { ...page, reviews })
      return
    }
    if (path === '/api/npm/reviews') {
      await handleNpmReviews(req, res, deps, cookie, url.searchParams); return
    }
    if (path === NPM_DELTAS_PATH) { await handleNpmDeltas(req, res, deps, cookie, url.searchParams); return }
    if (NPM_PATHS.has(path)) {
      await handleNpm(req, res, deps, cookie, path, url.searchParams); return
    }
    if (path === LOGOUT_PATH) { await handleLogout(req, res, deps, cookie); return }
    if (deps.serveStatic?.(req, res)) return
    if (deps.next) { deps.next(req, res); return }
    sendJson(res, 404, { error: 'not-found' }, { connection: 'close' })
  }

  // Each request's time told in its Server-Timing header (request-timing.ts).
  return (req, res) => runTimed(res, () => {
    if (isShuttingDown()) { sendJson(res, 503, { error: 'shutting-down' }, { connection: 'close' }); return }
    if (!deps.originGate.isOriginAllowed(req)) { sendJson(res, 403, { error: 'origin-denied' }); return }
    // Feeds lease a connection per poll, never across streaming sleeps. This
    // also covers capability-authenticated feeds handled by public-workspace;
    // and a team's dependencies and npm's deltas, streamed as GitHub and npm
    // are waited on, lease one a statement.
    const feed = /^\/api\/teams(?:\/[^/?]+)?\/feed(?:\?|$)/u.test(req.url ?? '') || /^\/api\/(?:teams\/[^/?]+\/dependencies|npm\/deltas)(?:\?|$)/u.test(req.url ?? '')
    const serve = () => runRequestPresence(() => db.withRequest && !feed ? db.withRequest(() => route(req, res)) : route(req, res))
    const work = runViewing(viewToken(config, req.headers.cookie) != null, serve).catch((err) => {
      if ((err instanceof TeamReportsError || err instanceof IssueError || err instanceof OAuthError || err instanceof ManagedMutationError) && !res.headersSent) { sendJson(res, err.status, { error: err.message }); return }
      console.warn('managed: request handler error:', err)
      if (res.headersSent) { try { res.destroy() } catch {} }
      else sendJson(res, 500, { error: 'internal' })
    })
    track(work)
    return work
  })
}
