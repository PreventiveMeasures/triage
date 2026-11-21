// A package installed from a directory: Stasis records one an ecosystem's
// `:directory` (`npm:directory`, a `file:` dependency pnpm and yarn copy into
// node_modules), naming the directory it was copied from (`directory`). It is
// the repository's own code, wherever that directory is, in the repository
// or outside it, not any registry's package of its name: never reviewed as a
// dependency, here or by the host's reviewed dependencies, nor audited. No
// archive was installed, so its record carries no integrity.
interface Recorded { ecosystem?: unknown; integrity?: unknown; directory?: unknown; name?: unknown; version?: unknown }

export const isDirectoryEcosystem = (ecosystem: unknown): ecosystem is string => typeof ecosystem === 'string' && ecosystem.endsWith(':directory')

// Whether `info`, recorded as installed from a directory, isn't as Stasis
// records one: with an integrity, or naming no directory.
export const malformedDirectoryPackage = (info: Recorded) => isDirectoryEcosystem(info.ecosystem)
  && (info.integrity !== undefined || typeof info.directory !== 'string' || info.directory === '')

export const MALFORMED_DIRECTORY_PACKAGE = 'Recorded as installed from a directory, but with an integrity or naming no directory.'

// Whether `info` is a package installed from a directory, the repository's
// own code; one recorded so that is malformed throws.
export function isDirectoryPackage(info: Recorded | null | undefined): boolean {
  if (!info || !isDirectoryEcosystem(info.ecosystem)) return false
  if (malformedDirectoryPackage(info)) {
    throw Object.assign(new Error(`${String(info.name ?? 'A package')}@${String(info.version ?? '?')} (${info.ecosystem}): ${MALFORMED_DIRECTORY_PACKAGE}`),
      { code: 'directory-package-malformed' })
  }
  return true
}
