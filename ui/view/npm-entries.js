// Where an npm package's manifest points into its files, and its license
// files: the npm viewer's entry points and license (npm-package.js), and
// Compare's labels on them (bundle-compare-code.js).

// The file of `files` an entry point names, as require would find it:
// `./lib/a` as `lib/a`, `lib/a.js`, `.cjs` or `.mjs`, or `lib/a/index.js`;
// undefined where none is there. The Overview's entry points and the file
// Code opens on both resolve this way.
export function npmEntryFile(field, files) {
  const base = npmEntryPath(field)
  return [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}/index.js`].find(path => path && files?.has(path))
}

export const npmEntryPath = field => field.replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '')

// Its license files at its root: `LICENSE`, or one a license, such as
// `LICENSE-MIT`, `LICENCE-APACHE.md`.
export const NPM_LICENSE_FILE = /^licen[cs]e(?:-[\w.]+)?(?:\.(?:md|txt))?$/iu

// A license expression's parts, `{ text, file }`, each license in it with
// the file of `paths` it opens: the one named after it (`LICENSE-APACHE` for
// `Apache-2.0`), else the package's only license file; null for none, and
// for the operators and parentheses between them.
export function npmLicenseParts(license, paths) {
  const licenseFiles = paths.filter(path => NPM_LICENSE_FILE.test(path))
  const fileFor = id => {
    const key = id.toLowerCase().match(/^[a-z]+/u)?.[0] ?? ''
    const named = licenseFiles.find(path => {
      const suffix = path.toLowerCase().match(/^licen[cs]e-([a-z]+)/u)?.[1]
      return suffix !== undefined && key !== '' && (suffix.startsWith(key) || key.startsWith(suffix))
    })
    return named ?? (licenseFiles.length === 1 ? licenseFiles[0] : null)
  }
  return license.split(/(\s+(?:OR|AND|WITH)\s+|[()])/u).filter(Boolean)
    .map(text => ({ text, file: /^[\w.+-]+$/u.test(text) && !/^(?:OR|AND|WITH)$/u.test(text) ? fileFor(text) : null }))
}
