import type { BundleDetails } from './bundle-metadata.js'
import type { Package } from '@preventive/upstream/advisories.js'
export function bundleSourcesAsMap(details: BundleDetails): Map<string, string>
export function bundlePackageVersions(details: BundleDetails, paths?: Iterable<string> | null): Map<string, Set<string>>
export function bundleAdvisoryPackages(details: BundleDetails, paths?: Iterable<string> | null): Package[]
