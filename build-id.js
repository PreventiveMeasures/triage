// The build a page's own files are of, written on the page itself (build.js,
// over out/*.html) and on every URL it asks for one of them by, so that a
// page and the bundles it loads are of one build, wherever they are served
// from. view.js, view.css and the bundles loaded at runtime (client-
// managed.js, dialogs.js… ui/view/built.js) keep their names from build to
// build, and a cache that keeps one past a release (a host serving out/ with
// no Cache-Control, by a modification time npm sets the same for every
// release) could hand a page one build's view.js beside another's
// client-managed.js, whose exports it lacks. Asked for under the page's
// build, each is either the page's own or none the cache has. Chunks are
// named by their content already, and the page names no build in them: they
// stay the same files from build to build where their code does.
import { createHash } from 'node:crypto'

// The meta element naming the build on a page (ui/view/built.js reads it).
export const BUILD_META = 'deepview-build'

// The build's id: a hash of its scripts and styles, `[path, content]`, by
// their paths, so the same files are ever the same build.
export function buildId(files) {
  const hash = createHash('sha256')
  for (const [path, content] of files.toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) hash.update(`${path}\0${content.length}\0`).update(content)
  return hash.digest('hex').slice(0, 16)
}

// `html` naming build `id`, after its charset where it declares one, and
// asking for its own scripts and styles under it, its chunks as they are.
export function stampedHtml(html, id) {
  const charset = '<meta charset="utf-8">'
  const named = html.includes(charset) ? html.replace(charset, `${charset}\n<meta name="${BUILD_META}" content="${id}">`) : html
  return named.replaceAll(/((?:href|src)="\.\/)(?!chunk-)([\w.-]+\.(?:css|js))"/gu, `$1$2?v=${id}"`)
}
