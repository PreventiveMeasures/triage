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

const sourcesCache = new WeakMap()
const filesCache = new WeakMap()
const sizesCache = new WeakMap()
const sourceSizesCache = new WeakMap()

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

// The length of the bytes a base64 spelling decodes to — three for every
// four characters, less what the padding stands for. The terminal's own
// arithmetic, so `ls -l` and `wc -c` there agree with the views here.
function base64ByteLength(text) {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  return Math.floor((text.length - padding) * 3 / 4)
}

// Every path the bundle records, keyed to the byte size of the file it
// holds — the size `wc -c` reports for it in the terminal, which is to
// say the size of the entry in `bundleFilesAsMap`: a source or `resource`
// weighs the UTF-8 its text encodes to, a `resource:base64` the bytes its
// base64 decodes to. Null is a path that is no file: a directory capture,
// or a sourcemap source whose body was left out.
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
  const encoder = new TextEncoder()
  const files = bundleFilesAsMap(details)
  const paths = details?.kind === 'stasis' ? details.bundle?.sources.keys() : details?.json?.sources
  for (const path of paths ?? []) {
    const content = files.get(path)
    sizes.set(path, typeof content === 'string' ? encoder.encode(content).byteLength
      : content?.format === 'base64' ? base64ByteLength(content.data) : null)
  }
  if (key) sizesCache.set(key, sizes)
  return sizes
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
export function bundlePackageVersions(details) {
  const versions = new Map()
  if (details?.kind !== 'stasis' || !details.bundle?.modules) return versions
  for (const [dir, info] of details.bundle.modules) {
    if (!dir.includes('node_modules')) continue
    if (!info?.name || typeof info.version !== 'string' || !info.version) continue
    let set = versions.get(info.name)
    if (!set) { set = new Set(); versions.set(info.name, set) }
    set.add(info.version)
  }
  return versions
}
