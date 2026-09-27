export const BUNDLE_METADATA_VERSION: number
export interface BundleIdentity { integrity: string; kind: string | null; size: number }
export interface BundleDetails extends BundleIdentity { bundle?: unknown; json?: unknown }
export function parseBundleContents(text: string, identity: BundleIdentity): BundleDetails
export function createBundleMetadata(details: BundleDetails): Promise<Record<string, unknown>>
