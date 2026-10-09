// npm package names, versions and scopes as the managed npm viewer takes
// them, shared by its routes, the server and the Teams page.

// Upstream's rule (@preventive/upstream src/args.js): a scope, then a name
// starting with none of `.`, `_` and `-`, 214 characters in all.
const PACKAGE_NAME = /^(?=.{1,214}$)(?:@[\w.-]+\/[\w-]|[\dA-Za-z])[\w.-]*$/u
// An exact version or a dist-tag, as the registry resolves `/<name>/<spec>`.
const PACKAGE_SPEC = /^(?=.{1,256}$)[\dA-Za-z][\w.+-]*$/u
// npm's rule for a scope: lowercase, and not starting with `.` or `_`.
const SCOPE = /^@[\da-z~-][\w.~-]*$/u
export const MAX_TEAM_NPM_SCOPES = 100

export function isNpmPackageName(value) {
  return typeof value === 'string' && PACKAGE_NAME.test(value)
}

export function isNpmPackageSpec(value) {
  return typeof value === 'string' && PACKAGE_SPEC.test(value)
}

// `@scope` of a scoped name, lowercased as scopes are compared; null for an
// unscoped one.
export function npmPackageScope(name) {
  return name.startsWith('@') && name.includes('/') ? name.slice(0, name.indexOf('/')).toLowerCase() : null
}

// A scope as typed: `scope` or `@scope`, either case, surrounding space
// ignored. Null when it is not one npm could publish under.
export function normalizeNpmScope(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  const scope = trimmed.startsWith('@') ? trimmed : `@${trimmed}`
  return scope.length <= 214 && SCOPE.test(scope) ? scope : null
}
