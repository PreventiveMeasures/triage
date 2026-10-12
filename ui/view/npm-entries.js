// Where an npm package's manifest points into its files: the npm viewer's
// entry points (npm-package.js), and Compare's labels on them
// (bundle-compare-code.js).

// The file of `files` an entry point names, as require would find it:
// `./lib/a` as `lib/a`, `lib/a.js`, `.cjs` or `.mjs`, or `lib/a/index.js`;
// undefined where none is there. The Overview's entry points and the file
// Code opens on both resolve this way.
export function npmEntryFile(field, files) {
  const base = npmEntryPath(field)
  return [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}/index.js`].find(path => path && files?.has(path))
}

export const npmEntryPath = field => field.replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '')
