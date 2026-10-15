import type { Root } from '@preventive/compare'
import type { BundleDetails } from './bundle-metadata.js'
// A comparison as Compare and Review read it; `files.basePaths` maps every
// base file to how it reads as the other side lays its files out.
export interface Comparison extends Record<string, unknown> {
  files: Record<string, unknown> & { root: Root | null; basePaths: Map<string, string> }
}
export function prepareComparison(base: BundleDetails, other: BundleDetails, scope?: string | null): Comparison
