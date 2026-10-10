// A sourcemap bundle as @preventive/sourcemap reads it: plain or indexed,
// each file once, with the edges between its files. A file keeps the key
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

// `read`'s edges between files of the map, `Map<from, Set<to>>` by key: an
// edge to no file of it (a package left out, a builtin) leads nowhere here.
export function sourcemapEdges(map, read) {
  const edges = new Map()
  for (const { from, to } of read(map).edges) {
    if (from.source === null || to?.source == null) continue
    if (!edges.has(from.source)) edges.set(from.source, new Set())
    edges.get(from.source).add(to.source)
  }
  return edges
}

// edges-lite.js throws for a map that is not Metro's: one with no edges the
// client can tell.
function liteEdges(map) {
  try { return metroEdges(map) } catch { return { edges: [] } }
}

// The edges a view draws: those the metadata carries, else what the client
// reads of its own map. None without a map.
export function bundleSourcemapEdges(details) {
  if (details?.edges) return details.edges
  if (!details?.map) return new Map()
  details.edges = sourcemapEdges(details.map, liteEdges)
  return details.edges
}
