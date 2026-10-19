// A bundle loaded at runtime, asked for under the build its page names
// (build-id.js): `path`, beside the page, with the build as `v` and `params`,
// so the page never runs beside another build's copy of it, as a cache that
// keeps one past a release would hand over under its bare name. The page
// names none under the development server, nor under the tests, and the
// path is asked for as it is. Read once, from the page's head, which a
// module script runs after.
const build = globalThis.document?.querySelector?.('meta[name="deepview-build"]')?.getAttribute('content') || null

export function built(path, params = {}) {
  const query = new URLSearchParams({ ...build ? { v: build } : {}, ...params }).toString()
  return query ? `${path}?${query}` : path
}
