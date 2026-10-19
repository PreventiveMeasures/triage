export const MAX_TEAM_NPM_SCOPES: number
export function isNpmPackageName(value: unknown): value is string
export function isNpmPackageSpec(value: unknown): value is string
export function isPatchHash(value: unknown): value is string
export function isPatchPath(value: unknown): value is string
export function npmPackageScope(name: string): string | null
export function normalizeNpmScope(value: unknown): string | null
