import type { BundleDetails } from './bundle-metadata.js'
export function bundleReasons(details: BundleDetails, sourcePaths?: Iterable<string>): Map<string, Set<string>>
export function bundleEntryPoints(details: BundleDetails, sourcePaths?: Iterable<string>): string[]
export interface BundleScopes {
  reasons: Map<string, Set<string>>
  entries: string[]
  has(id: unknown): boolean
  files(id: unknown): Set<string> | null
}
export function bundleScopes(details: BundleDetails, sourcePaths?: Iterable<string>): BundleScopes
export interface BundleScopeOption { id: string; label: string }
export function bundleScopeOptions(scopes: Pick<BundleScopes, 'reasons' | 'entries'>): { reasons: BundleScopeOption[]; entries: BundleScopeOption[] }
