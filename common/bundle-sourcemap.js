// A sourcemap bundle as @preventive/sourcemap reads it: plain or indexed,
// each file once, with the edges between its files, which the graph draws
// and Code links follow by the specifier of each import. A file keeps the key
// it had before the package read it, the spelling the map lists it under
// (`sourceRoot` in front), so Code links, hashes and reports that name one
// still find it.
//
// Edges take a parser for most maps. The client goes without one: it reads
// them with edges-lite.js, which knows Metro's maps alone. The server reads
// every map's with oxc-parser (server-managed/bundle-cache.ts) and keeps
// them in the bundle's metadata, which a client takes over its own.
import { readSourceMap } from '@preventive/sourcemap'
import { bundleEdges as metroEdges } from '@preventive/sourcemap/edges-lite.js'

// The map as read, and what the Overview shows of the JSON: its header,
// and how many names it maps. The JSON itself is not kept, its mappings
// read and its sources the map's files.
export function parseSourcemap(text) {
  // The `)]}'` line that guards a map against being run, which readSourceMap
  // skips in text it parses itself.
  const json = JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/u, ''))
  const map = readSourceMap(json)
  const namesCount = json.sections
    ? json.sections.reduce((count, section) => count + (section.map.names?.length ?? 0), 0)
    : json.names?.length ?? null
  return { json: { version: json.version, file: json.file, sourceRoot: json.sourceRoot }, map, namesCount }
}

// The map's files as `[key, content or null]`, in its order. Details with
// no map read (the npm viewer's, a map's arrays as written) list what their
// `sources` does, a repeated path repeated.
export function sourcemapEntries(details) {
  if (details.map) return details.map.files.flatMap((file) => file.source === null ? [] : [[file.source, file.content]])
  const contents = details.json?.sourcesContent ?? []
  return (details.json?.sources ?? []).map((path, i) => [path, contents[i] ?? null])
}

// `read`'s edges between files of the map, as rows by key: `[from, to]`,
// and `[from, to, specifier]` for an import its specifier names. An edge to
// no file of it (a package left out, a builtin) leads nowhere here.
export function sourcemapEdges(map, read) {
  const rows = new Map()
  for (const { from, to, specifier } of read(map).edges) {
    if (from.source === null || to?.source == null) continue
    const row = typeof specifier === 'string' ? [from.source, to.source, specifier] : [from.source, to.source]
    rows.set(row.join('\0'), row)
  }
  return [...rows.values()]
}

// edges-lite.js throws for a map that is not Metro's, or one with no
// sourcesContent to read: one with no edges the client can tell.
function liteEdges(map) {
  try { return metroEdges(map) } catch { return { edges: [] } }
}

const NO_EDGES = Object.freeze([])

// The edges a view reads: those the metadata carries, else what the client
// reads of its own map. None without a map.
export function bundleSourcemapEdges(details) {
  if (details?.edges) return details.edges
  if (!details?.map) return NO_EDGES
  details.edges = sourcemapEdges(details.map, liteEdges)
  return details.edges
}

const importsCache = new WeakMap()
const specifiersCache = new WeakMap()

// The graph's: `Map<from, Set<to>>`.
export function bundleSourcemapImports(details) {
  const rows = bundleSourcemapEdges(details)
  if (!importsCache.has(rows)) {
    const imports = new Map()
    for (const [from, to] of rows) {
      if (!imports.has(from)) imports.set(from, new Set())
      imports.get(from).add(to)
    }
    importsCache.set(rows, imports)
  }
  return importsCache.get(rows)
}

// Code links': the file each import's specifier names, `Map<from,
// Map<specifier, to>>`.
export function bundleSourcemapSpecifiers(details) {
  const rows = bundleSourcemapEdges(details)
  if (!specifiersCache.has(rows)) {
    const specifiers = new Map()
    for (const [from, to, specifier] of rows) {
      if (specifier === undefined) continue
      if (!specifiers.has(from)) specifiers.set(from, new Map())
      specifiers.get(from).set(specifier, to)
    }
    specifiersCache.set(rows, specifiers)
  }
  return specifiersCache.get(rows)
}
