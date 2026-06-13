// SBOM serializers for stasis bundles — CycloneDX (1.5) and SPDX
// (2.3), both as JSON. A stasis `Bundle` records per-package metadata
// in its `modules` Map (`Map<dir, { name, version, files }>`, see
// `@exodus/stasis/bundle`): `node_modules/...` dirs are upstream
// dependencies, non-`node_modules` dirs are workspace packages (the
// `.` root + any monorepo siblings). That inventory maps onto an SBOM
// component list, so we can emit a bill of materials straight from a
// parsed bundle — no registry round-trip (unlike the Advisories tab,
// which only needs name+version too).
//
// The `.` workspace module is the document's primary/root component;
// every other named+versioned module — registry deps AND any monorepo
// workspace siblings — is listed as a component. This is a flat
// inventory, not a resolved dependency graph: the bundle inlines the
// full transitive set without per-edge provenance, so we don't claim
// edges we can't substantiate beyond root→component.
//
// Pure module: no Lit / DOM / `state` imports, so the tests exercise
// it directly and the download wiring (Blob + `downloadBlob`) stays in
// `events.js`. Both builders take `{ now, uuid }` options so callers
// (and tests) can pin the otherwise-nondeterministic timestamp +
// document identifier.

// Identifies this app as the SBOM's creating tool (the package name).
const TOOL_NAME = '@preventive/triage'

// npm Package URL for a component, per the purl spec's npm type: the
// name is lowercased (the spec requires npm names be lowercased) and,
// for scoped names, split into a percent-encoded namespace + name
// (`@scope/pkg` → `pkg:npm/%40scope/pkg@1.2.3`); plain names stay flat
// (`pkg:npm/lodash@4.17.21`). The version is percent-encoded so
// build-metadata `+` and the like survive as a valid purl, but not
// lowercased — versions are case-sensitive.
function npmPurl(name, version) {
  const lower = name.toLowerCase()
  let namespace = ''
  let bare = lower
  if (lower.startsWith('@')) {
    const slash = lower.indexOf('/')
    if (slash > 0) {
      namespace = lower.slice(0, slash)
      bare = lower.slice(slash + 1)
    }
  }
  const nsPart = namespace ? `${encodeURIComponent(namespace)}/` : ''
  return `pkg:npm/${nsPart}${encodeURIComponent(bare)}@${encodeURIComponent(version)}`
}

// Strip a bundle's stasis suffix for a clean SBOM filename / document
// name: `ses.stasis.code.br` → `ses`. Falls back to dropping the final
// extension for anything else, and to the unchanged name if that would
// empty it.
export function sbomBaseName(name) {
  const stasis = /^(.*?)\.stasis\.(?:code|resources)\.br$/u.exec(name)
  if (stasis) return stasis[1]
  return name.replace(/\.[^.]+$/u, '') || name
}

// Collect SBOM components from a parsed stasis bundle: every module
// carrying a concrete name + version, de-duped by `name@version` (a
// package present both hoisted and nested appears once; distinct
// versions are kept — a bundle can legitimately ship two). On a key
// collision the workspace-root (`.`) copy claims the slot, so a
// self-dependency — a package that also pulls a registry copy of
// itself — keeps the root as the document root rather than letting the
// `node_modules` copy (which `Bundle.parseCode` records first) demote
// it to a leaf. `dir` rides along so the document builders can
// separate the root from everything else. Empty for sourcemaps and v0
// stasis bundles (which record no name/version).
export function bundleSbomComponents(details) {
  const out = []
  if (details?.kind !== 'stasis' || !details.bundle?.modules) return out
  const indexByKey = new Map()
  for (const [dir, info] of details.bundle.modules) {
    if (!info?.name || typeof info.version !== 'string' || !info.version) continue
    const key = `${info.name}@${info.version}`
    const seenAt = indexByKey.get(key)
    if (seenAt !== undefined) {
      if (dir === '.') out[seenAt].dir = '.'
      continue
    }
    indexByKey.set(key, out.length)
    out.push({ name: info.name, version: info.version, dir })
  }
  return out
}

// Cheap existence check for the render path — true as soon as one
// module carries a concrete name + version, so the Overview can decide
// whether to show the SBOM buttons without building (and discarding)
// the full component array on every render.
export function bundleHasSbomComponents(details) {
  if (details?.kind !== 'stasis' || !details.bundle?.modules) return false
  for (const [, info] of details.bundle.modules) {
    if (info?.name && typeof info.version === 'string' && info.version) return true
  }
  return false
}

// Split the components into the single workspace root (the `.` module,
// when present) and everything else. With no `.` module (a
// `scope: node_modules` bundle) the root is synthesized from the
// bundle filename so the document still has a thing it describes.
function splitRoot(components, entry) {
  const rootComp = components.find((c) => c.dir === '.') ?? null
  const rest = rootComp ? components.filter((c) => c !== rootComp) : components
  const root = rootComp
    ? { name: rootComp.name, version: rootComp.version, purl: npmPurl(rootComp.name, rootComp.version) }
    : { name: sbomBaseName(entry?.name ?? 'bundle'), version: null, purl: null }
  return { root, rest }
}

function newUuid(uuid) {
  return uuid ?? globalThis.crypto.randomUUID()
}

// CycloneDX 1.5 JSON. The workspace root is the metadata component
// (type application); every other package is a library component with
// an npm purl as its bom-ref. Pretty-printed with a trailing newline
// so the file reads cleanly and diffs sanely.
export function bundleToCycloneDx(details, entry, { now = new Date(), uuid } = {}) {
  const components = bundleSbomComponents(details)
  const { root, rest } = splitRoot(components, entry)
  const rootComponent = { type: 'application', 'bom-ref': root.purl ?? `application:${root.name}`, name: root.name }
  if (root.version) rootComponent.version = root.version
  if (root.purl) rootComponent.purl = root.purl
  const doc = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${newUuid(uuid)}`,
    version: 1,
    metadata: {
      timestamp: now.toISOString(),
      tools: { components: [{ type: 'application', name: TOOL_NAME }] },
      component: rootComponent,
    },
    components: rest.map((c) => {
      const purl = npmPurl(c.name, c.version)
      return { type: 'library', 'bom-ref': purl, name: c.name, version: c.version, purl }
    }),
  }
  return `${JSON.stringify(doc, null, 2)}\n`
}

function purlExternalRef(purl) {
  return { referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: purl }
}

// SPDX 2.3 JSON. The DOCUMENT DESCRIBES the workspace root package,
// which DEPENDS_ON each bundled component (a flat graph — the bundle
// inlines the full transitive set, so a root→each edge is the honest
// summary without inventing per-package edges we don't have). License
// / download fields are NOASSERTION: a stasis bundle records neither.
// The `created` stamp is trimmed to whole seconds (SPDX disallows
// fractional seconds).
export function bundleToSpdx(details, entry, { now = new Date(), uuid } = {}) {
  const components = bundleSbomComponents(details)
  const { root, rest } = splitRoot(components, entry)
  const docName = sbomBaseName(entry?.name ?? 'bundle')
  const created = now.toISOString().replace(/\.\d{3}Z$/u, 'Z')

  const mkPackage = (spdxId, name, version, purl) => {
    const pkg = {
      SPDXID: spdxId,
      name,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
    }
    if (version) pkg.versionInfo = version
    if (purl) pkg.externalRefs = [purlExternalRef(purl)]
    return pkg
  }

  const rootId = 'SPDXRef-Package-root'
  const packages = [mkPackage(rootId, root.name, root.version, root.purl)]
  const relationships = [
    { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: rootId },
  ]
  rest.forEach((c, i) => {
    const id = `SPDXRef-Package-${i + 1}`
    packages.push(mkPackage(id, c.name, c.version, npmPurl(c.name, c.version)))
    relationships.push({ spdxElementId: rootId, relationshipType: 'DEPENDS_ON', relatedSpdxElement: id })
  })

  const doc = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: docName,
    documentNamespace: `https://spdx.org/spdxdocs/${encodeURIComponent(docName)}-${newUuid(uuid)}`,
    creationInfo: {
      created,
      creators: [`Tool: ${TOOL_NAME}`],
    },
    packages,
    relationships,
  }
  return `${JSON.stringify(doc, null, 2)}\n`
}
