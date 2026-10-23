import type { BundleDetails } from './bundle-metadata.js'
export function bundleCompareFiles(details: BundleDetails, scope?: string | null): Map<string, unknown>
export function bundleCompareSideScopes(base: BundleDetails, other: BundleDetails, scope?: string | null): [string, string]
