// npm package names, versions and scopes as the managed npm viewer takes
// them, and the pnpm patches its reviews read, shared by its routes, the
// server and the Teams page.

// Upstream's rule (@preventive/upstream src/args.js): a scope, then a name
// starting with none of `.`, `_` and `-`, 214 characters in all.
const PACKAGE_NAME = /^(?=.{1,214}$)(?:@[\w.-]+\/[\w-]|[\dA-Za-z])[\w.-]*$/u
// An exact version or a dist-tag, as the registry resolves `/<name>/<spec>`.
const PACKAGE_SPEC = /^(?=.{1,256}$)[\dA-Za-z][\w.+-]*$/u
// npm's rule for a scope: lowercase, and not starting with `.` or `_`.
const SCOPE = /^@[\da-z~-][\w.~-]*$/u
export const MAX_TEAM_NPM_SCOPES = 100
// A pnpm patch's hash as a lockfile names it: a sha256 in hex, or pnpm 9's
// md5 in base32.
const PATCH_HASH = /^(?:[\da-f]{64}|[2-7a-z]{26})$/u

export function isNpmPackageName(value) {
  return typeof value === 'string' && PACKAGE_NAME.test(value)
}

export function isNpmPackageSpec(value) {
  return typeof value === 'string' && PACKAGE_SPEC.test(value)
}

export function isPatchHash(value) {
  return typeof value === 'string' && PATCH_HASH.test(value)
}

// A path as GitHub's contents take it, as a pnpm patch's file is read
// (server-managed/npm-patch.ts) and a file of the package it changes is
// named: names with no empty, `.` or `..` one among them, nor control
// characters or backslashes.
export function isPatchPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\p{Cc}\\]/u.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
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
