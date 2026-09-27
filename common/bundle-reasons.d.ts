import type { BundleDetails } from './bundle-metadata.js'
export function bundleReasons(details: BundleDetails, sourcePaths?: Iterable<string>): Map<string, Set<string>>
