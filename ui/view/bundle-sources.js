// Shared helper: given a parsed bundle `details`, return a
// Map<file, content-string> of its source files. Stasis bundles
// expose sources via `@exodus/stasis-core`'s `Bundle.sources` getter
// (flat Map<projectRelPath, content> from `.modules`); sourcemaps
// split them across parallel `sources` / `sourcesContent` arrays on
// the raw .map JSON. Sourcemap sources whose `sourcesContent[i]` was
// omitted are skipped.
//
// What a stasis bundle records is not all source: `Bundle.formats`
// marks each entry, and three of those formats are files only in the
// sense that they occupy a path. `Bundle.sources` hands back the raw
// stored content for every one of them, so the format is what has to
// be asked — the content's JS type cannot tell them apart:
//
//   directory        a readdir capture, content `["a.js","b.js"]`
//   resource:base64  an image or font, content its base64 text
//   resource         raw bytes, the one case not a string already
//
// A directory capture is the one that does real damage, because it
// claims a path a directory also occupies: hand it to the terminal
// and `ls` lists the name twice and stops listing what is under it.
// The base64 resources are quieter but equally wrong — a PNG read as
// a wall of text, counted toward the language shares that
// render-bundle.js says resources are kept out of.
//
// Own module so `render-bundle.js` (Code tab, finding tree, graph
// data) and `terminal-attach.js` (in-shell FS) read one definition —
// a new bundle kind or field handled here is visible to both.

import { Bundle } from '@exodus/stasis-core/bundle'
import { utf8ByteLength } from '../../common/utf8.js'

const sourcesCache = new WeakMap()
const filesCache = new WeakMap()
const sizesCache = new WeakMap()
const sourceSizesCache = new WeakMap()
const kindsCache = new WeakMap()
const unsizedCache = new WeakMap()

export function bundleSourcesAsMap(details) {
  if (details?.metadataOnly) return new Map()
  const key = details?.bundle ?? details?.json
  if (key && sourcesCache.has(key)) return sourcesCache.get(key)
  const result = new Map()
  if (!details) return result
  if (details.kind === 'stasis') {
    if (!details.bundle) return result
    const formats = details.bundle.formats
    for (const [file, content] of details.bundle.sources) {
      if (typeof content !== 'string') continue
      // `isResourceFormat` is the package's own list, so a format it
      // adds later is excluded here without this needing to know. A v0
      // bundle records no formats at all: `get` returns undefined,
      // which is not a resource format, and every entry is kept as
      // before.
      if (Bundle.isResourceFormat(formats?.get(file))) continue
      result.set(file, content)
    }
  } else if (details.kind === 'sourcemap') {
    if (!details.json) return result
    const srcs = details.json.sources ?? []
    const contents = details.json.sourcesContent ?? []
    for (let i = 0; i < srcs.length; i++) {
      if (typeof contents[i] === 'string') result.set(srcs[i], contents[i])
    }
  }
  if (key) sourcesCache.set(key, result)
  return result
}

// Every file the bundle carries, for a reader that wants the filesystem
// rather than the source: what `bundleSourcesAsMap` returns, plus the
// resources it leaves out, each in the form that is true to it.
//
// The two resource formats are not two encodings of the same thing.
// Stasis picks between them by whether the bytes are valid UTF-8:
// `resource` is that text, stored verbatim, so it stays a string and a
// reader sees the SVG or the licence file it is. `resource:base64` is
// the other case — bytes no string spells — and it is handed over
// still spelt that way, as `{ format: 'base64', data }`. The terminal
// takes that form since 2.0 and decodes it the first time the file is
// read, so a bundle carrying a hundred images costs a hundred strings
// rather than a hundred decoded buffers, and pays for the one that is
// opened. Either way it knows what it is holding: `ls -l` and `wc -c`
// report the real byte count rather than the length of the base64, and
// `cat` declines instead of printing mojibake.
//
// Decoding there also puts the diagnostic where the file is named: a
// spelling that does not decode is reported by the command that read
// it, under the detail `base64 source`. Decoding here could only drop
// the file and say nothing.
//
// Directory captures stay out. They are the one entry that is not a
// file in any encoding, and mounting one puts a second `lib` beside
// the directory it names.
export function bundleFilesAsMap(details) {
  const key = details?.bundle ?? details?.json
  if (key && filesCache.has(key)) return filesCache.get(key)
  const files = new Map(bundleSourcesAsMap(details))
  if (details?.kind === 'stasis' && details.bundle) {
    const formats = details.bundle.formats
    for (const [file, content] of details.bundle.sources) {
      if (typeof content !== 'string') continue
      const format = formats?.get(file)
      if (format === 'resource') files.set(file, content)
      else if (format === 'resource:base64') files.set(file, { format: 'base64', data: content })
    }
  }
  if (key) filesCache.set(key, files)
  return files
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// The length of the bytes a base64 spelling decodes to — three for every
// four characters, less what the padding stands for — or null when it
// decodes to none. The terminal decodes strictly (`@exodus/bytes`): RFC
// 4648's alphabet, no whitespace, padding present or left off but never
// wrong, and no stray bits in the last character. A spelling it refuses is
// a file `wc -c` cannot read, so it gets no size here rather than an
// invented one. Checked without decoding: a bundle's images are not worth
// a buffer each just to be weighed.
function base64ByteLength(text) {
  const padded = text.endsWith('=')
  if (padded ? text.length % 4 !== 0 || text.at(-3) === '=' : text.length % 4 === 1) return null
  const data = padded ? text.slice(0, text.endsWith('==') ? -2 : -1) : text
  if (/[^A-Za-z0-9+/]/u.test(data)) return null
  // A trailing group of 2 or 3 characters spells 1 or 2 bytes; the bits of
  // its last character past those bytes must be zero.
  const tail = data.length % 4
  if (tail > 1 && BASE64_ALPHABET.indexOf(data.at(-1)) & (tail === 2 ? 0x0f : 0x03)) return null
  return Math.floor(data.length * 3 / 4)
}

// The byte size of one entry of `bundleFilesAsMap`, as `wc -c` reports it
// in the terminal: text weighs the UTF-8 it encodes to, and a base64
// declaration the bytes it decodes to — null when it decodes to none.
// Anything else is no file, and null too. The Compare tab sizes both
// bundles' files by this, so its totals are the Overview's.
export function bundleFileByteLength(content) {
  if (typeof content === 'string') return utf8ByteLength(content)
  return content?.format === 'base64' ? base64ByteLength(content.data) : null
}

// Every path the bundle records, keyed to the byte size of the file it
// holds — the size `wc -c` reports for it in the terminal, which is to
// say the size of the entry in `bundleFilesAsMap`: a source or `resource`
// weighs the UTF-8 its text encodes to, a `resource:base64` the bytes its
// base64 decodes to. Null is a path with no size to give: a directory
// capture, which is no file; a sourcemap source whose body was left out;
// or a `resource:base64` whose spelling does not decode.
//
// The Overview and the Treemap weigh a bundle by this, so what they show
// adds up to what `du` does. Neither the source-only view nor the base64
// text will do: the first drops every image and font, the second
// inflates them by a third.
//
// Metadata views need byte sizes and paths, never the bodies. The
// persistent index supplies this map directly; full parses compute it once.
export function bundleFileSizes(details) {
  if (details?.fileSizes) return details.fileSizes
  const key = details?.bundle ?? details?.json
  if (key && sizesCache.has(key)) return sizesCache.get(key)
  const sizes = new Map()
  const files = bundleFilesAsMap(details)
  const paths = details?.kind === 'stasis' ? details.bundle?.sources.keys() : details?.json?.sources
  for (const path of paths ?? []) sizes.set(path, bundleFileByteLength(files.get(path)))
  if (key) sizesCache.set(key, sizes)
  return sizes
}

// The files the terminal mounts that have no size: a `resource:base64`
// whose spelling does not decode. The terminal lists such a file, and says
// why it cannot read it when asked, so the views list it too — but a null
// size alone cannot tell it from an entry that is no file at all, so it is
// named here. A metadata-only open reads the set from the index, which is
// the one thing a size and a format cannot say about a path.
export function bundleUnsizedFiles(details) {
  if (details?.metadataOnly) return details.unsizedFiles ?? new Set()
  const sizes = bundleFileSizes(details)
  if (unsizedCache.has(sizes)) return unsizedCache.get(sizes)
  const unsized = new Set()
  for (const path of bundleFilesAsMap(details).keys()) if (sizes.get(path) === null) unsized.add(path)
  unsizedCache.set(sizes, unsized)
  return unsized
}

// What each file the terminal mounts is, for a view that lists files:
// 'source', or 'resource' for an image, font or other asset — a file, sized
// like any other, but none the source viewer can show. Its keys are
// `bundleFilesAsMap`'s, and nothing else: a directory capture, or an entry
// with no body to mount (a sourcemap source whose `sourcesContent` was left
// out, a body that is no string), is no file and is absent. It reads sizes
// and formats, not bodies, so it answers for a metadata-only open as it
// does for a parsed one: a sized path is a mounted file, and so is one
// `bundleUnsizedFiles` names.
export function bundleFileKinds(details) {
  const sizes = bundleFileSizes(details)
  if (kindsCache.has(sizes)) return kindsCache.get(sizes)
  const unsized = bundleUnsizedFiles(details)
  const formats = details?.kind === 'stasis' ? details.bundle?.formats : null
  const kinds = new Map()
  for (const [path, size] of sizes) {
    if (size === null && !unsized.has(path)) continue
    kinds.set(path, Bundle.isResourceFormat(formats?.get(path)) ? 'resource' : 'source')
  }
  kindsCache.set(sizes, kinds)
  return kinds
}

// `bundleFileSizes` narrowed to source: a resource's size is nulled, as a
// directory capture's already is. The import graph draws this, and stays
// source-only: an image or a font imports nothing and carries no finding.
export function bundleSourceSizes(details) {
  const sizes = bundleFileSizes(details)
  const formats = details?.kind === 'stasis' ? details.bundle?.formats : null
  if (!formats || formats.size === 0) return sizes
  if (sourceSizesCache.has(sizes)) return sourceSizesCache.get(sizes)
  const result = new Map()
  for (const [path, size] of sizes) result.set(path, Bundle.isResourceFormat(formats.get(path)) ? null : size)
  sourceSizesCache.set(sizes, result)
  return result
}

// Map each stasis bundle source path to the package directory that
// owns it. A stasis `Bundle` already records authoritative package
// boundaries in `.modules` (a `Map<dir, { name, version, files }>`
// covering both `node_modules` deps and workspace packages — the
// PHP `vendor/<vendor>/<pkg>` case, monorepo workspaces, etc.); this
// mirrors the `Bundle.sources` getter's path construction (`dir/rel`,
// or just `rel` for the `.` root) so the returned keys line up exactly
// with `bundleSourcesAsMap`'s.
//
// The package views (overview, treemap, graph) otherwise classify
// paths with `bundlePkgOf`'s string heuristic, which only knows
// `node_modules/`/`dependencies/` and buckets everything else by
// top-level dir — collapsing sibling workspace packages under their
// shared parent (`vendor/aws/aws-crt-php` + `vendor/aws/aws-sdk-php`
// both fall under `vendor`). Feeding each path's dir into
// `bundlePkgOf` (`packageDir` option) keeps those packages separate.
//
// Returns null for sourcemap bundles (and anything without parsed
// modules) — they carry no package metadata, so callers fall back to
// the path heuristic alone.
export function bundlePackageDirs(details) {
  if (details?.kind !== 'stasis' || !details.bundle?.modules) return null
  const map = new Map()
  for (const [dir, info] of details.bundle.modules) {
    for (const rel of Object.keys(info.files)) {
      map.set(dir === '.' ? rel : `${dir}/${rel}`, dir)
    }
  }
  return map
}

// Map each named npm dependency a (stasis) bundle carries to the set of
// concrete versions present for it: `Map<name, Set<version>>`. Only
// `node_modules/...` modules that carry both a name and a non-empty
// version string count — stasis v1 `scope: 'full'` bundles merge
// workspace / own-source entries into the same `Bundle.modules` Map
// (often `version: '0.0.0'` or null), and those aren't upstream
// dependencies, so they're filtered out by the directory key. A package
// can map to more than one version (pnpm keeps duplicate majors side by
// side), hence the Set.
//
// Shared by the Advisories tab (a bulk registry lookup keyed on these
// pairs) and the Compare slide (the dependency version-update diff).
// Returns an empty Map for sourcemaps and v0 stasis bundles — neither
// carries per-module version metadata.
export function bundlePackageVersions(details, paths = null) {
  const versions = new Map()
  if (details?.kind !== 'stasis' || !details.bundle?.modules) return versions
  const packageDirs = paths === null ? null : bundlePackageDirs(details)
  const selectedDirs = paths === null ? null : new Set([...paths].map(path => packageDirs?.get(path)))
  for (const [dir, info] of details.bundle.modules) {
    if (selectedDirs && !selectedDirs.has(dir)) continue
    if (!dir.includes('node_modules')) continue
    if (!info?.name || typeof info.version !== 'string' || !info.version) continue
    let set = versions.get(info.name)
    if (!set) { set = new Set(); versions.set(info.name, set) }
    set.add(info.version)
  }
  return versions
}
