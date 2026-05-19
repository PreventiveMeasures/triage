// `client/bundle-finding-index.js` — OPFS-wide finding index. Uses
// `client/storage.js` under the hood, which falls back to gzipped
// localStorage when OPFS is unavailable (= the Node test
// environment). That path doubles as a clean test substrate: we
// seed reports via `saveFile`, then exercise the index.
//
// Coverage:
//   - hash-keyed lookup (findingsForFileHash)
//   - package-keyed view (getPackagesIndex)
//   - reportsForFinding (cross-report attribution by dedupe key)
//   - subscribeToBundleFindingIndex (notify on each report indexed)
//   - dedupe key fallback (id vs content-based)
//   - extractFindings shape variants (findings array, groups array,
//     mixed single + grouped entries)
//   - silent skip on non-JSON (markdown / CSV) files

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

function createLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => { store.clear() },
    get length() { return store.size },
    key: (i) => Array.from(store.keys())[i] ?? null,
  }
}
if (globalThis.localStorage === undefined) {
  globalThis.localStorage = createLocalStorage()
}

const { saveFile } = await import('../client/storage.js')
const {
  ensureBundleFindingsIndexed,
  findingsForFileHash,
  getPackagesIndex,
  getRepositoriesIndex,
  reportsForFinding,
  reportsForFindingByPackage,
  reportsForFindingByRepo,
  subscribeToBundleFindingIndex,
} = await import('../client/bundle-finding-index.js')
const { compareVersionsDesc } = await import('../client/bundle-finding-versions.js')

// Each test gets a unique report-name suffix so the in-memory storage
// cache (which doesn't get cleared between tests) doesn't bleed
// state. The index also tracks `indexed` (a module-level Set) — once
// a name is processed it skips re-indexing. Unique names per test
// avoid re-runs of identical content.
let nameCounter = 0
function uniqueName(stem) {
  nameCounter += 1
  return `${stem}-${Date.now()}-${nameCounter}.json`
}

async function seedReport(content) {
  const name = uniqueName('rpt')
  await saveFile(name, JSON.stringify(content))
  return name
}

describe('bundle-finding-index — hash-keyed lookup', () => {
  beforeEach(() => { /* in-memory state persists; test names are unique */ })

  it('joins findings across reports by fileHash', async () => {
    const hash = `H${Date.now()}-A`
    await seedReport({
      findings: [
        { id: 'f1', severity: 'high', file: 'src/a.js', fileHash: hash, description: 'first' },
      ],
    })
    await seedReport({
      findings: [
        { id: 'f2', severity: 'low', file: 'src/a.js', fileHash: hash, description: 'second' },
      ],
    })
    await ensureBundleFindingsIndexed()
    const list = findingsForFileHash(hash)
    assert.equal(list.length, 2)
    const ids = list.map((f) => f.id).toSorted()
    assert.deepEqual(ids, ['f1', 'f2'])
  })

  it('dedupes findings with the same id across reports', async () => {
    const hash = `H${Date.now()}-DEDUPE`
    await seedReport({
      findings: [
        { id: 'shared', severity: 'high', file: 'x.js', fileHash: hash, description: 'first hit' },
      ],
    })
    await seedReport({
      findings: [
        { id: 'shared', severity: 'high', file: 'x.js', fileHash: hash, description: 'first hit' },
      ],
    })
    await ensureBundleFindingsIndexed()
    const list = findingsForFileHash(hash)
    assert.equal(list.length, 1, 'duplicate id collapses to one bucket entry')
    assert.equal(list[0].description, 'first hit')
  })

  it('falls back to a content-based dedupe key when findings have no id', async () => {
    const hash = `H${Date.now()}-NOID`
    // Two id-less findings with identical (severity, description, file, line, fileHash).
    await seedReport({
      findings: [
        { severity: 'high', file: 'a.js', line: 1, fileHash: hash, description: 'same' },
      ],
    })
    await seedReport({
      findings: [
        { severity: 'high', file: 'a.js', line: 1, fileHash: hash, description: 'same' },
      ],
    })
    await ensureBundleFindingsIndexed()
    const list = findingsForFileHash(hash)
    assert.equal(list.length, 1, 'content-key dedupe collapses identical id-less findings')
  })

  it('returns an empty list for unknown hashes', () => {
    assert.deepEqual(findingsForFileHash('never-indexed'), [])
  })
})

describe('bundle-finding-index — reportsForFinding (cross-report attribution)', () => {
  it('returns every report name that contributed a given finding', async () => {
    const hash = `H${Date.now()}-MULTIREP`
    const r1 = await seedReport({
      findings: [
        { id: 'multi', severity: 'high', file: 'x.js', fileHash: hash, description: 'd' },
      ],
    })
    const r2 = await seedReport({
      findings: [
        { id: 'multi', severity: 'high', file: 'x.js', fileHash: hash, description: 'd' },
      ],
    })
    await ensureBundleFindingsIndexed()
    const finding = findingsForFileHash(hash).find((f) => f.id === 'multi')
    const reports = reportsForFinding(hash, finding)
    assert.deepEqual(reports.toSorted(), [r1, r2].toSorted())
  })

  it('returns an empty array for an unknown hash', () => {
    assert.deepEqual(reportsForFinding('never-indexed', { id: 'whatever' }), [])
  })
})

// Hash-free attribution paths used by the Packages and Repositories
// Issues views — markdown-parsed findings (Codex / Claude Security)
// don't carry `fileHash`, so `reportsForFinding` returns nothing. The
// per-package / per-repo buckets carry their own `_keyReports` map
// (mirror of byHash's `reports`); these two helpers walk that map.
//
// Regression for the round-12 audit H1+H2: an earlier shape read
// `bucket.keyReports` instead of the actual underscore-prefixed
// `_keyReports`, throwing `TypeError: Cannot read properties of
// undefined (reading 'get')` on the first non-empty lookup.
describe('bundle-finding-index — reportsForFindingByPackage', () => {
  it('returns every report name that contributed a finding to a package', async () => {
    const tag = `pkg-attr-${Date.now()}`
    const r1 = await seedReport({
      findings: [
        { id: `${tag}-f1`, severity: 'high', file: `node_modules/${tag}/a.js`, description: 'shared' },
      ],
    })
    const r2 = await seedReport({
      findings: [
        { id: `${tag}-f1`, severity: 'high', file: `node_modules/${tag}/a.js`, description: 'shared' },
      ],
    })
    await ensureBundleFindingsIndexed()
    const finding = getPackagesIndex().get(tag).findings.find((f) => f.id === `${tag}-f1`)
    const reports = reportsForFindingByPackage(tag, finding)
    assert.deepEqual(reports.toSorted(), [r1, r2].toSorted())
  })

  it('returns an empty array for an unknown package', () => {
    assert.deepEqual(reportsForFindingByPackage('never-indexed', { id: 'x' }), [])
  })

  it('returns an empty array when the finding has no matching dedupe key', async () => {
    const tag = `pkg-empty-${Date.now()}`
    await seedReport({
      findings: [
        { id: `${tag}-real`, severity: 'high', file: `node_modules/${tag}/a.js`, description: 'd' },
      ],
    })
    await ensureBundleFindingsIndexed()
    // The package exists but the finding shape doesn't match anything we indexed.
    assert.deepEqual(reportsForFindingByPackage(tag, { id: `${tag}-fictional`, file: 'nope.js' }), [])
  })
})

describe('bundle-finding-index — reportsForFindingByRepo', () => {
  it('returns every report name that contributed an own-source finding to a repo', async () => {
    const tag = `repo-attr-${Date.now()}`
    const repo = `acme/${tag}`
    const r1 = await seedReport({
      findings: [
        // own source (no node_modules / dependencies prefix), repo
        // signal via `repo.github`.
        { id: `${tag}-f1`, severity: 'high', file: 'src/a.js', description: 'shared', repo: { github: repo } },
      ],
    })
    const r2 = await seedReport({
      findings: [
        { id: `${tag}-f1`, severity: 'high', file: 'src/a.js', description: 'shared', repo: { github: repo } },
      ],
    })
    await ensureBundleFindingsIndexed()
    const finding = getRepositoriesIndex().get(repo).findings.find((f) => f.id === `${tag}-f1`)
    const reports = reportsForFindingByRepo(repo, finding)
    assert.deepEqual(reports.toSorted(), [r1, r2].toSorted())
  })

  it('returns an empty array for an unknown repo', () => {
    assert.deepEqual(reportsForFindingByRepo('never-indexed', { id: 'x' }), [])
  })
})

describe('bundle-finding-index — package-keyed view', () => {
  it('aggregates findings by package extracted from file path', async () => {
    const tag = `pkg-${Date.now()}`
    await seedReport({
      findings: [
        // node_modules/<pkg>/...
        { id: `${tag}-f1`, severity: 'high', file: `node_modules/${tag}/lib/a.js`, description: 'A' },
        // dependencies/<pkg>/... — same pkg name resolves identical
        { id: `${tag}-f2`, severity: 'low', file: `dependencies/${tag}/sub/b.js`, description: 'B' },
        // own source — not in any package
        { id: `${tag}-f3`, severity: 'medium', file: 'src/main.js', description: 'C' },
      ],
    })
    await ensureBundleFindingsIndexed()
    const idx = getPackagesIndex()
    const bucket = idx.get(tag)
    assert.ok(bucket, `package "${tag}" indexed`)
    assert.equal(bucket.findings.length, 2, 'own source skipped')
    const ids = bucket.findings.map((f) => f.id).toSorted()
    assert.deepEqual(ids, [`${tag}-f1`, `${tag}-f2`])
  })

  it('walks past .pnpm shim segments to the real package name', async () => {
    const tag = `pnpm-${Date.now()}`
    await seedReport({
      findings: [
        {
          id: `${tag}-f1`,
          severity: 'high',
          // pnpm layout: .pnpm/<name>@<ver>/node_modules/<name>/lib
          file: `node_modules/.pnpm/${tag}@1.0.0/node_modules/${tag}/lib/x.js`,
          description: 'pnpm-shim',
        },
      ],
    })
    await ensureBundleFindingsIndexed()
    const idx = getPackagesIndex()
    assert.ok(idx.get(tag), `real package name (not .pnpm) wins for ${tag}`)
    assert.equal(idx.get('.pnpm'), undefined, '.pnpm itself never surfaces as a package')
  })

  it('captures @scope/name packages whole', async () => {
    const tag = `scoped${Date.now()}`
    await seedReport({
      findings: [
        { id: `${tag}-f1`, severity: 'high', file: `node_modules/@chalker/${tag}/index.js`, description: 'd' },
      ],
    })
    await ensureBundleFindingsIndexed()
    const idx = getPackagesIndex()
    assert.ok(idx.get(`@chalker/${tag}`), 'scoped package name preserved')
  })

  it('groups files within a package and tracks contributing reports', async () => {
    const tag = `multi-file-${Date.now()}`
    const r1 = await seedReport({
      findings: [
        { id: `${tag}-f1`, severity: 'high', file: `node_modules/${tag}/a.js`, description: 'd1' },
        { id: `${tag}-f2`, severity: 'high', file: `node_modules/${tag}/b.js`, description: 'd2' },
      ],
    })
    const r2 = await seedReport({
      findings: [
        { id: `${tag}-f3`, severity: 'low', file: `node_modules/${tag}/a.js`, description: 'd3' },
      ],
    })
    await ensureBundleFindingsIndexed()
    const bucket = getPackagesIndex().get(tag)
    assert.equal(bucket.files.size, 2, 'two distinct files in this package')
    assert.equal(bucket.files.get(`node_modules/${tag}/a.js`).length, 2)
    assert.equal(bucket.files.get(`node_modules/${tag}/b.js`).length, 1)
    assert.deepEqual([...bucket.reports].toSorted(), [r1, r2].toSorted())
  })
})

describe('bundle-finding-index — per-version sub-buckets', () => {
  it('splits a package by version pulled from .pnpm path segments', async () => {
    const tag = `versioned-${Date.now()}`
    await seedReport({
      findings: [
        { id: `${tag}-v1-a`, severity: 'high', file: `node_modules/.pnpm/${tag}@1.0.0/node_modules/${tag}/a.js`, description: 'v1a' },
        { id: `${tag}-v1-b`, severity: 'high', file: `node_modules/.pnpm/${tag}@1.0.0/node_modules/${tag}/b.js`, description: 'v1b' },
        { id: `${tag}-v2-a`, severity: 'low', file: `node_modules/.pnpm/${tag}@2.0.0/node_modules/${tag}/a.js`, description: 'v2a' },
      ],
    })
    await ensureBundleFindingsIndexed()
    const bucket = getPackagesIndex().get(tag)
    assert.ok(bucket.byVersion instanceof Map, 'byVersion present')
    assert.equal(bucket.byVersion.size, 2, 'two version slots')
    assert.equal(bucket.byVersion.get('1.0.0').findings.length, 2, 'v1 has both findings')
    assert.equal(bucket.byVersion.get('2.0.0').findings.length, 1, 'v2 has one finding')
  })

  it('strips pnpm peer-dep suffix from the encoded segment', async () => {
    const tag = `peer-${Date.now()}`
    await seedReport({
      findings: [
        { id: `${tag}-f`, severity: 'high', file: `node_modules/.pnpm/${tag}@1.2.3_react@18.0.0/node_modules/${tag}/x.js`, description: 'p' },
      ],
    })
    await ensureBundleFindingsIndexed()
    const bucket = getPackagesIndex().get(tag)
    assert.ok(bucket.byVersion.get('1.2.3'), 'bare version, no peer-dep tail')
  })

  it('extracts the version for @scope/name packages encoded with `+`', async () => {
    const tag = `scoped${Date.now()}`
    await seedReport({
      findings: [
        { id: `${tag}-f`, severity: 'high', file: `node_modules/.pnpm/@chalker+${tag}@5.6.7/node_modules/@chalker/${tag}/x.js`, description: 's' },
      ],
    })
    await ensureBundleFindingsIndexed()
    const bucket = getPackagesIndex().get(`@chalker/${tag}`)
    assert.ok(bucket, 'scoped package bucketed')
    assert.ok(bucket.byVersion.get('5.6.7'), 'scoped version extracted')
  })

  it('files outside a .pnpm shim land in the null version slot', async () => {
    const tag = `plain-${Date.now()}`
    await seedReport({
      findings: [
        { id: `${tag}-f1`, severity: 'high', file: `node_modules/${tag}/lib/a.js`, description: 'plain' },
        { id: `${tag}-f2`, severity: 'high', file: `node_modules/.pnpm/${tag}@9.9.9/node_modules/${tag}/lib/b.js`, description: 'pnpm' },
      ],
    })
    await ensureBundleFindingsIndexed()
    const bucket = getPackagesIndex().get(tag)
    assert.ok(bucket.byVersion.get(null), 'null slot for plain node_modules path')
    assert.ok(bucket.byVersion.get('9.9.9'), 'known version slot for pnpm path')
    assert.equal(bucket.findings.length, 2, 'aggregate still carries both')
  })
})

// Report findings can carry `package: { npm: { name, version? } }`
// when the analyzer has identified the upstream package directly
// (no path-guessing). The index prefers that signal over the file-
// path extraction; the path remains the fallback (so reports that
// don't stamp `package.npm` still bucket correctly).
describe('bundle-finding-index — analyzer-stamped package.npm overrides path extraction', () => {
  it('uses package.npm.name to bucket a finding under a path-disagreeing package', async () => {
    const tag = `stamped-${Date.now()}`
    await seedReport({
      findings: [
        // file path would bucket under `src/foo.js` (own source) but
        // the analyzer stamped the real upstream — the stamped name wins.
        { id: `${tag}-f1`, severity: 'high', file: 'src/foo.js', description: 'stamped', package: { npm: { name: tag } } },
      ],
    })
    await ensureBundleFindingsIndexed()
    const bucket = getPackagesIndex().get(tag)
    assert.ok(bucket, 'package bucketed under stamped name, not path extraction')
    assert.equal(bucket.findings.length, 1)
  })

  it('uses package.npm.version for the per-version slot on plain node_modules paths', async () => {
    const tag = `stamped-ver-${Date.now()}`
    await seedReport({
      findings: [
        // path has no .pnpm shim → path extraction would land in
        // the null slot. The stamped version overrides that.
        { id: `${tag}-f1`, severity: 'high', file: `node_modules/${tag}/x.js`, description: 'd', package: { npm: { name: tag, version: '3.2.1' } } },
      ],
    })
    await ensureBundleFindingsIndexed()
    const bucket = getPackagesIndex().get(tag)
    assert.ok(bucket.byVersion.get('3.2.1'), 'stamped version slot present')
    assert.equal(bucket.byVersion.get(null), undefined, 'null slot skipped when version stamped')
  })

  it('prefers stamped name over the file-path package when they disagree', async () => {
    const tag = `stamped-mismatch-${Date.now()}`
    const wrongFromPath = `other-${tag}`
    await seedReport({
      findings: [
        // Path says `wrongFromPath`, stamp says `tag` — stamp wins.
        { id: `${tag}-f1`, severity: 'high', file: `node_modules/${wrongFromPath}/x.js`, description: 'd', package: { npm: { name: tag } } },
      ],
    })
    await ensureBundleFindingsIndexed()
    assert.ok(getPackagesIndex().get(tag), 'stamped name wins')
    assert.equal(getPackagesIndex().get(wrongFromPath), undefined, 'path-derived name is not used when stamp is present')
  })

  it('falls back to the file-path package when the stamp is absent or empty', async () => {
    const tag = `unstamped-${Date.now()}`
    await seedReport({
      findings: [
        { id: `${tag}-f1`, severity: 'high', file: `node_modules/${tag}/x.js`, description: 'no-stamp' },
        // empty stamp doesn't count — falls back to path extraction.
        { id: `${tag}-f2`, severity: 'high', file: `node_modules/${tag}/y.js`, description: 'empty-stamp', package: { npm: { name: '' } } },
      ],
    })
    await ensureBundleFindingsIndexed()
    const bucket = getPackagesIndex().get(tag)
    assert.ok(bucket, 'unstamped + empty-stamped findings still land under the path-extracted package')
    assert.equal(bucket.findings.length, 2)
  })

  it('keeps a stamp-only finding (no file) out of the repository index', async () => {
    // A finding with only a stamp + a non-deps source file should still
    // be classified as "in a package", so the repository index skips it.
    const tag = `stamp-skips-repo-${Date.now()}`
    await seedReport({
      findings: [
        // own-source file path + package stamp + a repo signal.
        // Without the package stamp, this would land in the
        // repositories index (own source + a github URL). The stamp
        // promotes it to "in a package", so repositories skip it.
        { id: `${tag}-f1`, severity: 'high', file: 'src/own.js', description: 'd', package: { npm: { name: tag } }, repo: { github: `acme/${tag}` } },
      ],
    })
    await ensureBundleFindingsIndexed()
    assert.ok(getPackagesIndex().get(tag), 'finding lands in packages via stamp')
    assert.equal(getRepositoriesIndex().get(`acme/${tag}`), undefined, 'stamped finding skipped from repositories')
  })
})

describe('bundle-finding-index — version comparator', () => {
  // `compareVersionsDesc` runs in descending order, so a negative
  // result means the first argument is the "newer" (sorts earlier).
  const newer = (a, b) => assert.ok(compareVersionsDesc(a, b) < 0, `${a} ranks above ${b}`)
  const equal = (a, b) => assert.equal(compareVersionsDesc(a, b), 0, `${a} equals ${b}`)

  it('ranks higher major / minor / patch first', () => {
    newer('2.0.0', '1.0.0')
    newer('1.2.0', '1.1.9')
    newer('1.0.5', '1.0.4')
  })

  it('compares numeric segments numerically, not lexically', () => {
    newer('1.10.0', '1.2.0')
    newer('1.0.10', '1.0.2')
  })

  it('release > pre-release on the same base', () => {
    newer('1.0.0', '1.0.0-beta.1')
    newer('1.0.0-beta.2', '1.0.0-beta.1')
  })

  it('null versions sort last', () => {
    newer('0.0.1', null)
    assert.ok(compareVersionsDesc(null, '0.0.1') > 0, 'null after a known version')
    equal(null, null)
  })

  it('equal inputs return 0', () => {
    equal('1.2.3', '1.2.3')
  })
})

describe('bundle-finding-index — extract shape variants', () => {
  it('handles `findings` as an array of mixed single + grouped entries', async () => {
    const tag = `mixed-${Date.now()}`
    await seedReport({
      findings: [
        // single Finding
        { id: `${tag}-1`, severity: 'high', file: `node_modules/${tag}/x.js`, description: 'a' },
        // grouped Finding[]
        [
          { id: `${tag}-2`, severity: 'low', file: `node_modules/${tag}/y.js`, description: 'b' },
          { id: `${tag}-3`, severity: 'low', file: `node_modules/${tag}/y.js`, description: 'c' },
        ],
      ],
    })
    await ensureBundleFindingsIndexed()
    const ids = getPackagesIndex().get(tag).findings.map((f) => f.id).toSorted()
    assert.deepEqual(ids, [`${tag}-1`, `${tag}-2`, `${tag}-3`])
  })

  it('reads `groups` when `findings` is absent (deepview-native dump shape)', async () => {
    const tag = `grouped-${Date.now()}`
    await seedReport({
      groups: [
        [{ id: `${tag}-1`, severity: 'high', file: `node_modules/${tag}/x.js`, description: 'a' }],
      ],
    })
    await ensureBundleFindingsIndexed()
    const bucket = getPackagesIndex().get(tag)
    assert.ok(bucket, 'groups-shaped report indexed')
    assert.equal(bucket.findings.length, 1)
  })

  it('silently skips files that fail JSON.parse (markdown imports etc.)', async () => {
    // Save a non-JSON file and verify ensureBundleFindingsIndexed
    // doesn't throw; the file just doesn't contribute anything.
    const name = uniqueName('rpt-md')
    await saveFile(name, '# Not JSON\nplain prose here')
    await ensureBundleFindingsIndexed()
    // Sanity check: a fresh hash from a JSON report still indexes after.
    const tag = `after-skip-${Date.now()}`
    await seedReport({
      findings: [{ id: `${tag}-1`, severity: 'high', file: `node_modules/${tag}/x.js`, description: 'd' }],
    })
    await ensureBundleFindingsIndexed()
    assert.ok(getPackagesIndex().get(tag), 'subsequent JSON report still indexes after a skipped non-JSON one')
  })

  it('inherits run-level meta from the report header onto findings without their own', async () => {
    const tag = `meta-${Date.now()}`
    await seedReport({
      type: 'analysis',
      model: 'claude-opus-4-7',
      effort: 'high',
      findings: [
        // No per-finding meta → inherit from header
        { id: `${tag}-1`, severity: 'high', file: `node_modules/${tag}/x.js`, description: 'a' },
        // Has its own meta → keep
        { id: `${tag}-2`, severity: 'high', file: `node_modules/${tag}/y.js`, description: 'b', model: 'other-model' },
      ],
    })
    await ensureBundleFindingsIndexed()
    const findings = getPackagesIndex().get(tag).findings
    const f1 = findings.find((f) => f.id === `${tag}-1`)
    const f2 = findings.find((f) => f.id === `${tag}-2`)
    assert.equal(f1.model, 'claude-opus-4-7', 'inherits model from report header')
    assert.equal(f1.effort, 'high', 'inherits effort from report header')
    assert.equal(f2.model, 'other-model', 'preserves per-finding meta')
  })

  it('does NOT inherit report-level meta when data.source is set (codex/claude-security)', async () => {
    const tag = `nosource-${Date.now()}`
    await seedReport({
      type: 'security',
      source: 'claude-security', // opt-out marker
      model: 'should-not-inherit',
      findings: [
        { id: `${tag}-1`, severity: 'high', file: `node_modules/${tag}/x.js`, description: 'a' },
      ],
    })
    await ensureBundleFindingsIndexed()
    const f = getPackagesIndex().get(tag).findings[0]
    assert.equal(f.model, undefined, 'source-marked report does not stamp meta on findings')
  })
})

describe('bundle-finding-index — subscribe', () => {
  it('fires the listener as new reports get indexed', async () => {
    let calls = 0
    const unsub = subscribeToBundleFindingIndex(() => { calls += 1 })
    const beforeCalls = calls
    const tag = `sub-${Date.now()}`
    await seedReport({
      findings: [
        { id: `${tag}-1`, severity: 'high', file: `node_modules/${tag}/x.js`, description: 'a' },
      ],
    })
    await ensureBundleFindingsIndexed()
    assert.ok(calls > beforeCalls, 'subscriber notified after a report indexed')
    unsub()
    const afterUnsub = calls
    const tag2 = `sub2-${Date.now()}`
    await seedReport({
      findings: [
        { id: `${tag2}-1`, severity: 'low', file: `node_modules/${tag2}/x.js`, description: 'b' },
      ],
    })
    await ensureBundleFindingsIndexed()
    assert.equal(calls, afterUnsub, 'unsubscribed listener no longer fires')
  })

  it('listener errors are swallowed (one bad subscriber doesn\'t break the chain)', async () => {
    let goodCalls = 0
    const unsubBad = subscribeToBundleFindingIndex(() => { throw new Error('boom') })
    const unsubGood = subscribeToBundleFindingIndex(() => { goodCalls += 1 })
    const beforeGood = goodCalls
    const tag = `swallow-${Date.now()}`
    await seedReport({
      findings: [
        { id: `${tag}-1`, severity: 'high', file: `node_modules/${tag}/x.js`, description: 'd' },
      ],
    })
    await ensureBundleFindingsIndexed()
    assert.ok(goodCalls > beforeGood, 'good subscriber still fires despite bad one throwing')
    unsubBad()
    unsubGood()
  })
})

// Round-12 audit M-A: indexFindingByPackage / indexFindingByRepo used
// to return `false` when a key already existed, even when the call
// had just registered a NEW contributing report against that key.
// `indexOne`'s `added` flag stayed false → no `notify()` fired →
// Packages / Repositories subscribers didn't repaint to reflect the
// new chip. Now both functions return `wasNewReport` (mirroring the
// hash-keyed path's contract) so a fresh contribution surfaces in
// the UI on the next walk.
describe('bundle-finding-index — re-import notifies subscribers (audit round-12 M-A)', () => {
  it('a new report contributing the same dedupe key in a package fires notify', async () => {
    const tag = `pkg-renotify-${Date.now()}`
    // First report — populates the bucket.
    await seedReport({
      findings: [
        { id: `${tag}-shared`, severity: 'high', file: `node_modules/${tag}/a.js`, description: 'd' },
      ],
    })
    await ensureBundleFindingsIndexed()

    // Second report — same dedupe key (id), different report name.
    // Pre-fix `indexFindingByPackage` returned false on the existing
    // key, suppressing notify() for the new contribution.
    let calls = 0
    const unsub = subscribeToBundleFindingIndex(() => { calls += 1 })
    const before = calls
    await seedReport({
      findings: [
        { id: `${tag}-shared`, severity: 'high', file: `node_modules/${tag}/a.js`, description: 'd' },
      ],
    })
    await ensureBundleFindingsIndexed()
    assert.ok(calls > before, 'new contribution to existing package key notifies subscribers')
    unsub()
  })

  it('a new report contributing the same dedupe key in a repo fires notify', async () => {
    const tag = `repo-renotify-${Date.now()}`
    const repo = `acme/${tag}`
    await seedReport({
      findings: [
        { id: `${tag}-shared`, severity: 'high', file: 'src/a.js', description: 'd', repo: { github: repo } },
      ],
    })
    await ensureBundleFindingsIndexed()

    let calls = 0
    const unsub = subscribeToBundleFindingIndex(() => { calls += 1 })
    const before = calls
    await seedReport({
      findings: [
        { id: `${tag}-shared`, severity: 'high', file: 'src/a.js', description: 'd', repo: { github: repo } },
      ],
    })
    await ensureBundleFindingsIndexed()
    assert.ok(calls > before, 'new contribution to existing repo key notifies subscribers')
    unsub()
  })
})
