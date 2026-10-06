import type { BundleDetails } from './bundle-metadata.js'
export function bundleSourcesAsMap(details: BundleDetails): Map<string, string>
export function bundleFilesAsMap(details: BundleDetails): Map<string, string | { format: 'base64'; data: string }>
export function bundlePackageDirs(details: BundleDetails): Map<string, string> | null
export function bundlePackageVersions(details: BundleDetails, paths?: Iterable<string> | null): Map<string, Set<string>>
