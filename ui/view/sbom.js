// SBOM serializers for stasis bundles — CycloneDX (1.5) and SPDX (2.3)
// JSON — straight from a parsed bundle's `modules` inventory
// (`Map<dir, { name, version, files }>`, @exodus/stasis-core/bundle), no
// registry round-trip. The `.` workspace module is the root component and
// every other named, versioned module (registry deps and monorepo
// siblings alike) a component: a flat inventory, since the bundle inlines
// the transitive set without per-edge provenance, so no edges beyond
// root → component are claimed.
//
// Pure (the download wiring is events.js's); `{ now, uuid }` pin the
// timestamp and document id for callers and tests.

// The SBOM's creating tool: this package.
const TOOL_NAME = '@preventive/triage'

// npm Package URL, per the purl spec's npm type: the name lowercased, a
// scoped one split into a percent-encoded namespace and name
// (`pkg:npm/%40scope/pkg@1.2.3`); the version percent-encoded (so a
// build-metadata `+` survives) but not lowercased, being case-sensitive.
function npmPurl(name, version) {
  const lower = name.toLowerCase()
  const slash = lower.startsWith('@') ? lower.indexOf('/') : -1
  const path = slash > 0 ? `${encodeURIComponent(lower.slice(0, slash))}/${encodeURIComponent(lower.slice(slash + 1))}` : encodeURIComponent(lower)
  return `pkg:npm/${path}@${encodeURIComponent(version)}`
}

// A bundle's name without its stasis suffix (`ses.stasis.code.br` →
// `ses`), else without its last extension, else unchanged.
export function sbomBaseName(name) {
  const stasis = /^(.*?)\.stasis\.(?:code|resources)\.br$/u.exec(name)
  if (stasis) return stasis[1]
  return name.replace(/\.[^.]+$/u, '') || name
}

// A module carrying a concrete name and version.
const named = (info) => info?.name && typeof info.version === 'string' && info.version

// A parsed stasis bundle's SBOM components: every named module, de-duped
// by `name@version` (hoisted and nested copies once; distinct versions
// kept). On a collision the workspace root (`.`) claims the slot, so a
// package pulling a registry copy of itself stays the document root rather
// than the `node_modules` copy (which `Bundle.parseCode` records first)
// demoting it. `dir` lets the builders split the root off. Empty for
// sourcemaps and v0 stasis bundles (no name/version).
export function bundleSbomComponents(details) {
  const out = []
  if (details?.kind !== 'stasis' || !details.bundle?.modules) return out
  const indexByKey = new Map()
  for (const [dir, info] of details.bundle.modules) {
    if (!named(info)) continue
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

// The render path's cheap check (the Overview's SBOM buttons), without
// building the component list.
export function bundleHasSbomComponents(details) {
  if (details?.kind !== 'stasis' || !details.bundle?.modules) return false
  for (const [, info] of details.bundle.modules) {
    if (named(info)) return true
  }
  return false
}

// The workspace root (the `.` module) and the rest. Without one (a
// `scope: node_modules` bundle) the root is made from the bundle's name,
// so the document still describes something.
function splitRoot(components, entry) {
  const rootComp = components.find((c) => c.dir === '.') ?? null
  const rest = rootComp ? components.filter((c) => c !== rootComp) : components
  const root = rootComp
    ? { name: rootComp.name, version: rootComp.version, purl: npmPurl(rootComp.name, rootComp.version) }
    : { name: sbomBaseName(entry?.name ?? 'bundle'), version: null, purl: null }
  return { root, rest }
}

const newUuid = (uuid) => uuid ?? globalThis.crypto.randomUUID()

// CycloneDX 1.5: the root is the metadata component (an application),
// every other package a library with its purl as bom-ref. Pretty-printed,
// with a trailing newline.
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

// SPDX 2.3: the DOCUMENT DESCRIBES the root package, which DEPENDS_ON each
// component (the flat graph above). License and download fields are
// NOASSERTION, recorded by no stasis bundle; `created` is trimmed to whole
// seconds, as SPDX requires.
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
    if (purl) pkg.externalRefs = [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: purl }]
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
