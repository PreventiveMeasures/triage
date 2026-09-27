export const BUNDLE_METADATA_VERSION: number
export interface BundleIdentity { integrity: string; kind: string | null; size: number }
export interface BundleDetails extends BundleIdentity { bundle?: unknown; json?: unknown }
export function parseBundleContents(text: string, identity: BundleIdentity): BundleDetails
export interface BundleMetadata extends Record<string, unknown> {
  files: [string, number | null, string | null, number | null][]
  codeStats: { files: number; lines: number; bytes: number }
}
export function createBundleMetadata(details: BundleDetails): Promise<BundleMetadata>
export function createBundleSummary(details: BundleDetails, metadata: BundleMetadata): { files: number; codeFiles: number; lines: number }
