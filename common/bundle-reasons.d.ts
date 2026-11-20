import type { BundleDetails } from './bundle-metadata.js'
export function bundleReasons(details: BundleDetails, sourcePaths?: Iterable<string>): Map<string, Set<string>>
export interface BundleScopes { ids: string[]; has(id: unknown): boolean; files(id: string): Set<string> | null }
export function bundleScopes(details: BundleDetails, sourcePaths?: Iterable<string>): BundleScopes
export function scopeLabel(id: string): string
export function scopeOptions(scopes: BundleScopes): { id: string; label: string }[]
