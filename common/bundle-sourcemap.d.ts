import type { SourceMap } from '@preventive/sourcemap'
import type { Edge } from '@preventive/sourcemap/edges.js'
import type { BundleDetails } from './bundle-metadata.js'
export function parseSourcemap(text: string): { json: { version: unknown; file: unknown; sourceRoot: unknown }; map: SourceMap; namesCount: number | null }
export function sourcemapEntries(details: BundleDetails): [string, string | null][]
export type SourcemapEdge = [from: string, to: string] | [from: string, to: string, specifier: string]
export function sourcemapEdges(map: SourceMap, read: (map: SourceMap) => { edges: Edge[] }): SourcemapEdge[]
export function bundleSourcemapEdges(details: BundleDetails): readonly SourcemapEdge[]
export function bundleSourcemapImports(details: BundleDetails): Map<string, Set<string>>
export function bundleSourcemapSpecifiers(details: BundleDetails): Map<string, Map<string, string>>
