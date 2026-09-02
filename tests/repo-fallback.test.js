// `ui/view/group.js` — `findingRepoFallback`, the repo a finding's
// file / line links resolve against, and `findingRepo`, the identifier
// the handoff block names.
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
const { findingRepo, findingRepoFallback } = await import('../ui/view/group.js')
const { findingUrl } = await import('../ui/view/format.js')

const REPO = 'https://github.com/owner/name'
const finding = (extra = {}) => ({ file: 'src/a.js', line: 7, ...extra })

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
