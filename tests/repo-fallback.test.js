// `ui/view/group.js` — `findingRepoFallback`, the repo a finding's
// file / line links resolve against, `findingRepoTarget`, that repo
// paired with the `repo.directory` the report declared beside it, and
// `findingRepo`, the identifier the handoff block names.
//
// The chain is per-report stamp → the single-file view's typed URL,
// and the stamp is `''` (not absent) for a report with no repo of its
// own: ingest writes `loadRepoUrlFor(name)` verbatim, which is the
// empty string until someone types one. So the join has to be `||` —
// under `??` that empty stamp answered the query, and a URL typed into
// the header chip produced no links at all until the report was
// re-ingested (nothing re-stamps the findings already in
// `state.reports`; the chip only updates `state.repoUrl`).

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

// Polyfills for `localStorage` etc. — client modules pulled in
// transitively through `state.ts` touch them at module-load time.
import './_polyfills.js'

// group.js → format.js → frontend-global.js throws at module load when
// the `@rray/frontend` slot isn't installed; the boot path that
// installs it doesn't run under the test runner. None of these symbols
// is called by the repo resolvers.
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

const { state } = await import('../client/state.ts')
const { findingRepo, findingRepoFallback, findingRepoTarget } = await import('../ui/view/group.js')
const { configureRevalidation, findingUrl } = await import('../ui/view/format.js')
const { applyFilters, applyScopeFilters, repoOfFinding, repositoryFilterValues, resetFilters } = await import('../ui/view/filters.js')

const REPO = 'https://github.com/owner/name'
const finding = (extra = {}) => ({ file: 'src/a.js', line: 7, ...extra })
const repositoryOptions = (groups) => [...repositoryFilterValues(applyScopeFilters(groups))]

describe('findingRepoFallback', () => {
  beforeEach(() => { state.repoUrl = '' })

  it('falls through the empty ingest stamp to a URL typed later', () => {
    // The regression: report loaded with no repo (stamp `''`), user
    // then types one into the header chip. Nothing re-stamps the
    // loaded findings, so the typed URL has to win here or every link
    // stays dead until a reload.
    const f = finding({ _repoFallback: '' })
    state.repoUrl = REPO
    assert.equal(findingRepoFallback(f), REPO)
    assert.equal(
      findingUrl(f, findingRepoFallback(f)),
      `${REPO}/blob/HEAD/src/a.js#L7`,
      'and the link actually resolves',
    )
  })

  it('keeps the per-report stamp ahead of the global URL', () => {
    // Workspace mode: `state.repoUrl` can't represent N reports, so
    // each finding carries its own report's repo and must keep it.
    const f = finding({ _repoFallback: 'owner/from-report' })
    state.repoUrl = REPO
    assert.equal(findingRepoFallback(f), 'owner/from-report')
  })

  it('resolves a workspace finding with no typed URL at all', () => {
    const f = finding({ _repoFallback: 'owner/from-report' })
    assert.equal(findingRepoFallback(f), 'owner/from-report')
    assert.equal(findingUrl(f, findingRepoFallback(f)), 'https://github.com/owner/from-report/blob/HEAD/src/a.js#L7')
  })

  it('yields nothing linkable when no repo is known anywhere', () => {
    assert.equal(findingRepoFallback(finding({ _repoFallback: '' })), '')
    assert.equal(findingRepoFallback(finding()), '', 'missing stamp reads the same as an empty one')
    assert.equal(findingUrl(finding(), findingRepoFallback(finding())), null)
  })
})

describe('findingRepoTarget', () => {
  beforeEach(() => { state.repoUrl = '' })

  it('pairs the resolved repo with the report directory the ingest stamped', () => {
    // `"repo": { "github": "babel/babel", "directory": "packages/babel-core" }`
    // at the top of the report: the paths it writes are relative to
    // that package, so every link resolves under it.
    const f = finding({ _repoFallback: 'babel/babel', _repoDirectory: 'packages/babel-core' })
    assert.deepEqual(findingRepoTarget(f), { github: 'babel/babel', directory: 'packages/babel-core' })
    assert.equal(
      findingUrl(f, findingRepoTarget(f)),
      'https://github.com/babel/babel/blob/HEAD/packages/babel-core/src/a.js#L7',
    )
  })

  it('qualifies a URL typed later just the same', () => {
    // The directory is the report's statement about its own paths, so
    // it holds whichever repo answers — here the chip's, the report
    // having declared none of its own.
    const f = finding({ _repoFallback: '', _repoDirectory: 'packages/babel-core' })
    state.repoUrl = REPO
    assert.equal(
      findingUrl(f, findingRepoTarget(f)),
      `${REPO}/blob/HEAD/packages/babel-core/src/a.js#L7`,
    )
  })

  it('leaves a finding naming its own upstream out of it', () => {
    // A dependency's repo is not the project's monorepo, and the
    // project's subdirectory is no path inside it.
    const f = finding({ repo: { github: 'dependency/source' }, _repoFallback: 'owner/app', _repoDirectory: 'packages/app' })
    assert.equal(findingUrl(f, findingRepoTarget(f)), 'https://github.com/dependency/source/blob/HEAD/src/a.js#L7')
  })

  it('reads a report with no directory as the repo root', () => {
    for (const f of [finding({ _repoFallback: 'owner/name' }), finding({ _repoFallback: 'owner/name', _repoDirectory: '' })]) {
      assert.deepEqual(findingRepoTarget(f), { github: 'owner/name', directory: '' })
      assert.equal(findingUrl(f, findingRepoTarget(f)), 'https://github.com/owner/name/blob/HEAD/src/a.js#L7')
    }
    assert.deepEqual(findingRepoTarget(undefined), { github: '', directory: '' })
  })
})

describe('findingRepo', () => {
  beforeEach(() => { state.repoUrl = '' })

  it('prefers the analyzer-stamped repo over either fallback', () => {
    const f = finding({ repo: { github: 'owner/upstream' }, _repoFallback: 'owner/from-report' })
    state.repoUrl = REPO
    assert.equal(findingRepo(f), 'owner/upstream')
  })

  it('falls back the same way the link resolver does', () => {
    state.repoUrl = REPO
    assert.equal(findingRepo(finding({ _repoFallback: '' })), REPO)
    assert.equal(findingRepo(finding({ _repoFallback: 'owner/from-report' })), 'owner/from-report')
  })

  it('returns null — not an empty string — when nothing is known', () => {
    assert.equal(findingRepo(finding({ _repoFallback: '' })), null)
  })
})

describe('repository filter for DeepView App findings', () => {
  beforeEach(() => {
    state.reports = []
    state.repoUrl = ''
    state.currentWorkspace = 'workspace'
    state.showRevalidation = true
    state.upstreamOnly = false
    state.revalidationDetailed = false
    configureRevalidation(true)
    resetFilters()
  })

  const appFinding = (extra = {}) => finding({
    isApp: true, _source: null,
    repo: { github: 'dependency/source' }, _repoFallback: 'owner/app',
    ...extra,
  })

  it('uses the report repo for choices and matching, retaining the source for file links', () => {
    const f = appFinding()
    assert.equal(repoOfFinding(f), 'owner/app')
    state.filterRepo = 'owner/app'
    assert.deepEqual(applyFilters([[f]]), [[f]])
    state.filterRepo = 'dependency/source'
    assert.deepEqual(applyFilters([[f]]), [])
    assert.equal(findingUrl(f, findingRepoFallback(f)), 'https://github.com/dependency/source/blob/HEAD/src/a.js#L7')
    assert.equal(f.repo.github, 'dependency/source')
  })

  it('matches separate app reports independently even when they reference the same source repo', () => {
    const first = [appFinding()]
    const second = [appFinding({ _repoFallback: 'owner/other-app' })]
    state.filterRepo = 'owner/other-app'
    assert.deepEqual(applyFilters([first, second]), [second])
  })

  it('falls back to the source repo when the report repo is unavailable', () => {
    for (const _repoFallback of [undefined, null, '', 42]) {
      assert.equal(repoOfFinding(appFinding({ _repoFallback })), 'dependency/source')
    }
    assert.equal(repoOfFinding(appFinding({ repo: {}, _repoFallback: '' })), null)
    assert.equal(repoOfFinding(appFinding({ repo: {} })), 'owner/app')
  })

  it('keeps source-level DeepView findings matched by their source repo', () => {
    // The stamped layer flag decides this, not a fresh inference from revalidate.
    const f = appFinding({ isApp: false, revalidate: 'revalidation' })
    assert.equal(repoOfFinding(f), 'dependency/source')
    assert.equal(repoOfFinding(appFinding({ isApp: undefined })), 'dependency/source')
  })

  it('keeps imported App findings matched by their source repo', () => {
    for (const source of ['codex-security', 'claude-security', 'deepsec', 'piolium']) {
      assert.equal(repoOfFinding(appFinding({ _source: source })), 'dependency/source')
      assert.equal(repoOfFinding(appFinding({ source })), 'dependency/source')
    }
  })

  it('lists report repos without source repos from hidden underlying tabs', () => {
    const app = appFinding({ revalidate: 'revalidation' })
    const source = appFinding({ isApp: false })
    const other = appFinding({ _repoFallback: 'owner/other-app' })
    const groups = [[app, source], [other]]
    assert.deepEqual(repositoryOptions(groups), ['owner/app', 'owner/other-app'])
    // A visible source-only row still contributes its own repository.
    assert.deepEqual(repositoryOptions([...groups, [source]]), ['owner/app', 'owner/other-app', 'dependency/source'])
  })

  it('includes source repos when the underlying/source lens actually displays those findings', () => {
    const app = appFinding({ revalidate: 'revalidation' })
    const source = appFinding({ isApp: false })
    state.currentWorkspace = null
    state.revalidationDetailed = true
    assert.deepEqual(repositoryOptions([[app, source]]), ['owner/app', 'dependency/source'])
    configureRevalidation(false)
    assert.deepEqual(repositoryOptions([[source]]), ['dependency/source'])
  })

  it('uses the visible tabs of a linked workspace row', () => {
    const app = appFinding({ revalidate: 'revalidation' })
    const source = appFinding({ isApp: false })
    const linkedApp = appFinding({ _repoFallback: 'owner/linked-app' })
    const group = [app, source, linkedApp]
    group.linkedTabs = [app, linkedApp]
    assert.deepEqual(repositoryOptions([group]), ['owner/app', 'owner/linked-app'])
  })
})
