// `ui/view/sbom.js` — SBOM (CycloneDX 1.5 + SPDX 2.3) serializers for
// stasis bundles. Pure module (no Lit / DOM / state), so the test
// imports it straight, like `bundle-pkg-of.test.js`.
//
// Under test: the stasis `modules` inventory (Map<dir, {name, version,
// files}>) maps onto SBOM components — the `.` workspace module is the
// document's root/primary component, `node_modules/...` modules are its
// dependencies, name@version is de-duped, npm purls encode scopes, and
// both documents pin their nondeterministic bits via the `{ now, uuid }`
// options.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundleHasSbomComponents, bundleSbomComponents, bundleToCycloneDx, bundleToSpdx, sbomBaseName } from '../ui/view/sbom.js'

const NOW = new Date('2026-06-13T15:04:11.123Z')
const UUID = '00000000-0000-4000-8000-000000000000'
const OPTS = { now: NOW, uuid: UUID }

// Build a fake parsed stasis `details`. `mods` is [dir, name, version][].
function stasis(mods, { integrity = 'sha512-test' } = {}) {
  return {
    kind: 'stasis',
    integrity,
    bundle: { modules: new Map(mods.map(([dir, name, version]) => [dir, { name, version, files: {} }])) },
  }
}

const ENTRY = { name: 'app.stasis.code.br', integrity: 'sha512-test' }

const FULL = stasis([
  ['.', '@my/app', '1.2.3'],
  ['node_modules/lodash', 'lodash', '4.17.21'],
  ['node_modules/@babel/core', '@babel/core', '7.24.0'],
  // hoisted + nested copy of the same version → de-duped to one
  ['node_modules/x/node_modules/lodash', 'lodash', '4.17.21'],
  // a second, different version of lodash → kept as its own component
  ['node_modules/y/node_modules/lodash', 'lodash', '3.10.1'],
])

test('sbomBaseName strips the stasis suffix and falls back to last extension', () => {
  assert.equal(sbomBaseName('app.stasis.code.br'), 'app')
  assert.equal(sbomBaseName('vendor.stasis.resources.br'), 'vendor')
  assert.equal(sbomBaseName('foo.bar.js'), 'foo.bar')
  assert.equal(sbomBaseName('plain'), 'plain')
})

test('bundleSbomComponents collects name+version modules, de-dupes by name@version', () => {
  const comps = bundleSbomComponents(FULL)
  // @my/app, lodash@4.17.21, @babel/core@7.24.0, lodash@3.10.1 → 4 (one lodash@4 dropped)
  assert.equal(comps.length, 4)
  const lodashes = comps.filter((c) => c.name === 'lodash')
  assert.deepEqual(lodashes.map((c) => c.version).toSorted(), ['3.10.1', '4.17.21'])
  const root = comps.find((c) => c.dir === '.')
  assert.equal(root.name, '@my/app')
  assert.ok(comps.find((c) => c.name === '@babel/core').dir.includes('node_modules'))
})

test('bundleHasSbomComponents mirrors whether any named+versioned module exists', () => {
  assert.equal(bundleHasSbomComponents(FULL), true)
  assert.equal(bundleHasSbomComponents(null), false)
  assert.equal(bundleHasSbomComponents({ kind: 'sourcemap', json: {} }), false)
  const v0 = { kind: 'stasis', bundle: { modules: new Map([['lib', { name: null, version: null, files: {} }]]) } }
  assert.equal(bundleHasSbomComponents(v0), false)
})

test('bundleSbomComponents keeps the workspace root over a node_modules self-dependency copy', () => {
  // `Bundle.parseCode` records node_modules modules BEFORE the `.` root, so
  // the self-dep copy is seen first; the root must still claim the slot.
  const selfDep = stasis([
    ['node_modules/@my/app', '@my/app', '1.2.3'],
    ['.', '@my/app', '1.2.3'],
    ['node_modules/lodash', 'lodash', '4.17.21'],
  ])
  const comps = bundleSbomComponents(selfDep)
  assert.equal(comps.length, 2) // @my/app (deduped, root wins) + lodash
  assert.equal(comps.find((c) => c.name === '@my/app').dir, '.')

  const cdx = JSON.parse(bundleToCycloneDx(selfDep, ENTRY, OPTS))
  // real root is the primary component (versioned + purl), not a synthetic leaf
  assert.equal(cdx.metadata.component.name, '@my/app')
  assert.equal(cdx.metadata.component.version, '1.2.3')
  assert.equal(cdx.metadata.component.purl, 'pkg:npm/%40my/app@1.2.3')
  assert.deepEqual(cdx.components.map((c) => c.name), ['lodash']) // root not duplicated into components
})

test('bundleSbomComponents is empty for sourcemaps, v0 (no version), and null', () => {
  assert.deepEqual(bundleSbomComponents(null), [])
  assert.deepEqual(bundleSbomComponents({ kind: 'sourcemap', json: {} }), [])
  // v0-style: modules present but name/version null
  const v0 = { kind: 'stasis', bundle: { modules: new Map([['lib', { name: null, version: null, files: {} }]]) } }
  assert.deepEqual(bundleSbomComponents(v0), [])
})

test('bundleToCycloneDx: root metadata component + library components with npm purls', () => {
  const doc = JSON.parse(bundleToCycloneDx(FULL, ENTRY, OPTS))
  assert.equal(doc.bomFormat, 'CycloneDX')
  assert.equal(doc.specVersion, '1.5')
  assert.equal(doc.serialNumber, `urn:uuid:${UUID}`)
  assert.equal(doc.version, 1)
  assert.equal(doc.metadata.timestamp, '2026-06-13T15:04:11.123Z')
  assert.equal(doc.metadata.tools.components[0].name, '@preventive/triage')

  // root = the `.` workspace module, as the primary component
  assert.deepEqual(doc.metadata.component, {
    type: 'application',
    'bom-ref': 'pkg:npm/%40my/app@1.2.3',
    name: '@my/app',
    version: '1.2.3',
    purl: 'pkg:npm/%40my/app@1.2.3',
  })

  // components excludes the root; carries the deps (deduped, both lodash versions)
  assert.equal(doc.components.length, 3)
  const babel = doc.components.find((c) => c.name === '@babel/core')
  assert.deepEqual(babel, {
    type: 'library',
    'bom-ref': 'pkg:npm/%40babel/core@7.24.0',
    name: '@babel/core',
    version: '7.24.0',
    purl: 'pkg:npm/%40babel/core@7.24.0',
  })
  assert.deepEqual(
    doc.components.filter((c) => c.name === 'lodash').map((c) => c.purl).toSorted(),
    ['pkg:npm/lodash@3.10.1', 'pkg:npm/lodash@4.17.21'],
  )
})

test('bundleToCycloneDx: synthesizes a root from the filename when there is no `.` module', () => {
  const depsOnly = stasis([['node_modules/lodash', 'lodash', '4.17.21']])
  const doc = JSON.parse(bundleToCycloneDx(depsOnly, ENTRY, OPTS))
  assert.deepEqual(doc.metadata.component, {
    type: 'application',
    'bom-ref': 'application:app',
    name: 'app',
  })
  assert.equal(doc.components.length, 1)
  assert.equal(doc.components[0].purl, 'pkg:npm/lodash@4.17.21')
})

test('bundleToSpdx: DESCRIBES the root, which DEPENDS_ON each dependency', () => {
  const doc = JSON.parse(bundleToSpdx(FULL, ENTRY, OPTS))
  assert.equal(doc.spdxVersion, 'SPDX-2.3')
  assert.equal(doc.dataLicense, 'CC0-1.0')
  assert.equal(doc.SPDXID, 'SPDXRef-DOCUMENT')
  assert.equal(doc.name, 'app')
  assert.equal(doc.documentNamespace, `https://spdx.org/spdxdocs/app-${UUID}`)
  // SPDX created stamp is trimmed to whole seconds
  assert.equal(doc.creationInfo.created, '2026-06-13T15:04:11Z')
  assert.deepEqual(doc.creationInfo.creators, ['Tool: @preventive/triage'])

  // root package first, then one per dep (3 deduped deps) → 4 packages
  assert.equal(doc.packages.length, 4)
  const root = doc.packages[0]
  assert.equal(root.SPDXID, 'SPDXRef-Package-root')
  assert.equal(root.name, '@my/app')
  assert.equal(root.versionInfo, '1.2.3')
  assert.deepEqual(root.externalRefs, [
    { referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:npm/%40my/app@1.2.3' },
  ])
  assert.equal(root.licenseConcluded, 'NOASSERTION')
  assert.equal(root.downloadLocation, 'NOASSERTION')
  assert.equal(root.filesAnalyzed, false)

  // DOCUMENT DESCRIBES root
  assert.ok(doc.relationships.some((r) =>
    r.spdxElementId === 'SPDXRef-DOCUMENT' && r.relationshipType === 'DESCRIBES' && r.relatedSpdxElement === 'SPDXRef-Package-root'))
  // every dependency is a root DEPENDS_ON edge, and each package id is unique
  const depEdges = doc.relationships.filter((r) => r.relationshipType === 'DEPENDS_ON')
  assert.equal(depEdges.length, 3)
  assert.ok(depEdges.every((r) => r.spdxElementId === 'SPDXRef-Package-root'))
  const ids = doc.packages.map((p) => p.SPDXID)
  assert.equal(new Set(ids).size, ids.length)
})

test('npm purl percent-encodes scoped namespaces and version build metadata', () => {
  const mods = stasis([
    ['.', '@scope/root', '0.0.0'],
    ['node_modules/plus', 'plus', '1.0.0+build.5'],
  ])
  const doc = JSON.parse(bundleToCycloneDx(mods, ENTRY, OPTS))
  assert.equal(doc.metadata.component.purl, 'pkg:npm/%40scope/root@0.0.0')
  assert.equal(doc.components[0].purl, 'pkg:npm/plus@1.0.0%2Bbuild.5')
})

test('npm purl lowercases the package name (purl spec) but preserves the display name and version case', () => {
  const mods = stasis([['node_modules/UglifyJS', 'UglifyJS', '2.0.0-RC.1']])
  const doc = JSON.parse(bundleToCycloneDx(mods, ENTRY, OPTS))
  assert.equal(doc.components[0].purl, 'pkg:npm/uglifyjs@2.0.0-RC.1')
  assert.equal(doc.components[0].name, 'UglifyJS')
})

test('bundleToSpdx: synthesizes a version-less, ref-less root package when there is no `.` module', () => {
  const depsOnly = stasis([['node_modules/lodash', 'lodash', '4.17.21']])
  const doc = JSON.parse(bundleToSpdx(depsOnly, ENTRY, OPTS))
  const root = doc.packages[0]
  assert.equal(root.SPDXID, 'SPDXRef-Package-root')
  assert.equal(root.name, 'app')
  assert.equal(root.versionInfo, undefined)
  assert.equal(root.externalRefs, undefined)
  assert.equal(doc.packages.length, 2)
})

test('documents are internally consistent: unique bom-refs/SPDXIDs, resolvable relationships, trailing newline, deterministic', () => {
  const cdxText = bundleToCycloneDx(FULL, ENTRY, OPTS)
  const spdxText = bundleToSpdx(FULL, ENTRY, OPTS)
  assert.ok(cdxText.endsWith('\n'))
  assert.ok(spdxText.endsWith('\n'))
  // identical options → byte-identical output (no hidden nondeterminism)
  assert.equal(bundleToCycloneDx(FULL, ENTRY, OPTS), cdxText)

  const cdx = JSON.parse(cdxText)
  const refs = [cdx.metadata.component['bom-ref'], ...cdx.components.map((c) => c['bom-ref'])]
  assert.equal(new Set(refs).size, refs.length)

  const spdx = JSON.parse(spdxText)
  const idRe = /^SPDXRef-[a-zA-Z0-9.-]+$/u
  const ids = new Set([spdx.SPDXID, ...spdx.packages.map((p) => p.SPDXID)])
  for (const id of ids) assert.match(id, idRe)
  assert.equal(ids.size, spdx.packages.length + 1) // +1 for SPDXRef-DOCUMENT
  for (const r of spdx.relationships) {
    assert.ok(ids.has(r.spdxElementId), `unresolved spdxElementId ${r.spdxElementId}`)
    assert.ok(ids.has(r.relatedSpdxElement), `unresolved relatedSpdxElement ${r.relatedSpdxElement}`)
  }
})
