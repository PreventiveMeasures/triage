import type { BundleDetails } from './bundle-metadata.js'
export function bundleSourcesAsMap(details: BundleDetails): Map<string, string>
export function bundleSourceLines(content: string): number
export function bundleSourceOrder(sources: Map<string, string>): { paths: string[]; numbers: Map<string, number> }
export function bundleFilesAsMap(details: BundleDetails): Map<string, string | { format: 'base64'; data: string }>
export function bundlePackageDirs(details: BundleDetails): Map<string, string> | null
export function bundlePackageVersions(details: BundleDetails, paths?: Iterable<string> | null, keyOf?: (dir: string, info: { name: string; version: string }) => string): Map<string, Set<string>>
