import type { SourceMap } from '@preventive/sourcemap'
import type { Edge } from '@preventive/sourcemap/edges.js'
import type { BundleDetails } from './bundle-metadata.js'
export function parseSourcemap(text: string): { json: { version: unknown; file: unknown; sourceRoot: unknown }; map: SourceMap; namesCount: number | null }
export function sourcemapEntries(details: BundleDetails): [string, string | null][]
export function sourcemapEdges(map: SourceMap, read: (map: SourceMap) => { edges: Edge[] }): Map<string, Set<string>>
export function bundleSourcemapEdges(details: BundleDetails): Map<string, Set<string>>
