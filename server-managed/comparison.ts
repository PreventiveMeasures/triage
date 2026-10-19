// Compare's comparison of two managed bundles or two versions of an npm
// package, the one shown as a patch changes it where Review asks
// (GET /api/bundles/:id/comparison?other=, GET /api/npm/comparison):
// their files paired, at one path or renamed, with the sizes, resolutions,
// dependency versions and line counts its Overview and Code read beside them,
// as common/bundle-comparison.js prepareComparison works them out. The viewer
// of a managed bundle or a package has every comparison worked out here and
// loads none of the pairing itself. Answered as Brotli-encoded JSON, its
// `files.basePaths` (a Map) as `[path, as laid out]` pairs where the two
// sides' roots differ and none else, as the viewer reads none then. Access is
// the caller's to check.
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { prepareComparison } from '../common/bundle-comparison.js'
import type { BundleDetails } from '../common/bundle-metadata.js'
import type { OpenedBlob } from './blob-store.ts'
import { encodeBrotli } from './brotli.ts'
import { type NpmPackageFile, type NpmVersionDocument, npmFileRows } from './npm-packages.ts'
import type { NpmPatch } from './npm-patch.ts'

// A side with no files, as Review compares a package's first version with:
// one for each comparison, as working one out keeps its line counts on it.
export const emptySide = (): BundleDetails => ({ integrity: '(empty)', kind: 'sourcemap', size: 0, json: { version: 3, sources: [], sourcesContent: [] } })

// A version's files as the viewer reads them for a comparison (ui/view/npm-package.js
// npmPackageDetails): its texts, and those that are not text by their size and digest.
export function npmComparedSide(integrity: string, files: NpmPackageFile[]): BundleDetails & { npmBinaries: Map<string, { size: number; digest: string }> } {
  const rows = npmFileRows(files)
  return {
    integrity, kind: 'sourcemap', size: 0,
    json: { version: 3, sources: rows.map(([path]) => path), sourcesContent: rows.map(([, , text]) => text) },
    npmBinaries: new Map(rows.flatMap(([path, size, text, digest]) => (text === null ? [[path, { size, digest: digest! }] as const] : []))),
  }
}

// The comparison of `base` with `other`, within a reason `scope` where given, as sent.
export async function comparisonBody(base: BundleDetails, other: BundleDetails, scope = ''): Promise<OpenedBlob> {
  const comparison = prepareComparison(base, other, scope)
  const { files } = comparison
  const json = JSON.stringify({ ...comparison, files: { ...files, basePaths: files.root ? [...files.basePaths] : [] } })
  const body = await encodeBrotli(Buffer.from(json))
  return { size: body.byteLength, stream: Readable.from([body]) }
}

// A version's `files` as `patch` changes them (npm-patch.ts patchedFiles), as
// the viewer reads a version's (npm-loads.ts loadNpmPackageBody), with the
// patch, as sent: `{ name, version, private, integrity, patch, files }`.
export async function patchedVersionBody(doc: NpmVersionDocument, patch: NpmPatch, files: NpmPackageFile[]): Promise<OpenedBlob> {
  const json = JSON.stringify({ name: doc.name, version: doc.version, private: doc.private, integrity: doc.dist.integrity, patch, files: npmFileRows(files) })
  const body = await encodeBrotli(Buffer.from(json))
  return { size: body.byteLength, stream: Readable.from([body]) }
}
