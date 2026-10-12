import { bundleFileByteLength, bundleFilesAsMap } from './bundle-sources.js'

// Every differing file, including its original path, rename and metadata
// changes. `modified: false` distinguishes a pure rename or metadata change.
export function fileEntries(files) {
  const entries = new Map()
  if (!files) return entries
  for (const row of files.onlyBase) entries.set(row.path, { kind: 'removed', basePath: row.basePath, baseBytes: row.bytes, otherBytes: null })
  for (const row of files.onlyOther) entries.set(row.path, { kind: 'added', baseBytes: null, otherBytes: row.bytes })
  for (const row of files.changed) {
    const recorded = { ...row.meta ? { meta: row.meta } : {} }
    entries.set(row.path, row.renamedFrom == null
      ? { kind: 'changed', basePath: row.basePath, baseBytes: row.baseBytes, otherBytes: row.otherBytes, ...row.modified === false ? { modified: false } : {}, ...recorded }
      : { kind: 'renamed', basePath: row.basePath, renamedFrom: row.renamedFrom, modified: row.modified, baseBytes: row.baseBytes, otherBytes: row.otherBytes, ...recorded })
  }
  return entries
}

// A file's two sides, as `entry` names them, from the two bundles' details.
export function fileContents(base, other, path, { kind, basePath = path }) {
  let before = kind === 'added' ? '' : bundleFilesAsMap(base).get(basePath)
  let after = kind === 'removed' ? '' : bundleFilesAsMap(other).get(path)
  // An importer captured on one side only (or neither) is no change of
  // contents; what there is of it shows as unchanged.
  if (kind === 'repointed') before = after = after ?? before
  return { before, after }
}

// Include import-only changes in the same file model every viewer consumes.
export function comparisonEntries(base, other, files, resolutions = []) {
  const entries = fileEntries(files)
  if (!files) return entries
  for (const row of resolutions) {
    if (!entries.has(row.parent)) {
      const bytes = bundleFileByteLength(bundleFilesAsMap(other).get(row.parent) ?? bundleFilesAsMap(base).get(row.parent))
      entries.set(row.parent, { kind: 'repointed', baseBytes: bytes, otherBytes: bytes })
    }
    const entry = entries.get(row.parent)
    entry.repointed = [...(entry.repointed ?? []), row]
  }
  return entries
}

export function comparisonFileList(base, other, diff) {
  return [...comparisonEntries(base, other, diff.files, diff.resolutions?.changed)].map(([path, entry]) => ({
    path, ...entry, ...fileContents(base, other, path, entry),
  }))
}

// Optional source-size limits, independent of the rendered-row budget. Binary
// bytes count as well: a large resource must not disappear from this decision.
export function withinComparisonLimits(files, { maxBytes = Infinity, maxLines = Infinity } = {}) {
  if (maxBytes === Infinity && maxLines === Infinity) return true
  let bytes = 0, lines = 0
  for (const { before, after } of files) {
    for (const content of [before, after]) {
      bytes += bundleFileByteLength(content) ?? 0
      if (bytes >= maxBytes) return false
      if (typeof content === 'string' && content !== '') lines += (content.match(/\n/gu)?.length ?? 0) + Number(!content.endsWith('\n'))
      if (lines >= maxLines) return false
    }
  }
  return true
}
