import type { BundleDetails } from './bundle-metadata.js'
export function bundleSourcesAsMap(details: BundleDetails): Map<string, string>
export function bundlePackageVersions(details: BundleDetails, paths?: Iterable<string> | null): Map<string, Set<string>>
