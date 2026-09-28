import type { BundleDetails } from './bundle-metadata.js'

export function bundleSourceImports(details: BundleDetails, sources?: Map<string, string>): Map<string, Map<string, string | null>>
export function sourceLinkResolver(sources: Map<string, string>, parent: string, imports?: Map<string, Map<string, string | null>> | null): (specifier: string) => string | null
export function bundleSourceLinkResolver(details: BundleDetails, parent: string): (specifier: string) => string | null
