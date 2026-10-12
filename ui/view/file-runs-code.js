// What a file's code can do beyond itself, as risk tells it
// (risk/files/runs-code.js), as the npm Overview's Files list and Compare
// label a file: its tags, their tooltips, and each version's files read once.
import { html, nothing } from 'lit'
import { RUNS_CODE } from '../../risk/files/runs-code.js'
import { npmVersionFileRisk } from '../../risk/npm/compare.js'

export { RUNS_CODE, npmFoundAdded, npmRunsCode, npmRunsCodeFlags, npmRunsCodeKinds, npmRunsCodeWithout } from '../../risk/files/runs-code.js'
export { lineOf, npmIsScript } from '../../risk/files/script.js'

// What a version's file runs beyond itself, as risk read it, once a version
// (risk/npm/compare.js npmVersionFileRisk).
export const npmFileRunsCode = (details, path) => npmVersionFileRisk(details, path).runsCode

export const linesNote = lines => lines.length === 1 ? `line ${lines[0]}`
  : `lines ${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ` and ${(lines.length - 5).toLocaleString('en')} more` : ''}`

// The kinds a file holds, each named with its lines, by its own name where
// kinds share a tag: `eval (line 3), Function (line 5)`.
export const npmRunsCodeSaid = found => [...found].map(([kind, lines]) => `${RUNS_CODE.get(kind).name ?? RUNS_CODE.get(kind).tag} (${linesNote(lines)})`).join(', ')

// The one line a tag's lines (each kind's, or service's) are, undefined for
// several: where a click on the tag opens its file.
export const onlyLine = lineLists => {
  const lines = new Set(lineLists.flat())
  return lines.size === 1 ? [...lines][0] : undefined
}

// A tag's attributes opening `path` in the code viewer at `line`
// (`data-bundle-view-source`, events.js), scrolled to it: none without one.
export const opensAt = (path, line) => line === undefined ? { path: nothing, line: nothing } : { path, line }

// A file's tags, one for the kinds it holds (npmRunsCode) that share it, their
// lines in its tooltip, each by its name where kinds share it; with `was`,
// the kinds the file held as the version compared with has it (null for
// none), one it didn't hold saying so; with `path`, for a list whose rows
// open the file, a tag on one line opening it there.
export function npmRunsCodeTags(found, was, path) {
  if (!found) return nothing
  return [...Map.groupBy(found, ([kind]) => RUNS_CODE.get(kind).tag)].map(([tag, kinds]) => {
    const parts = kinds.map(([kind, lines]) => {
      const { name } = RUNS_CODE.get(kind)
      return `${name ? `${name}, ` : ''}${linesNote(lines)}${was !== undefined && !was?.has(kind) ? ', new' : ''}`
    })
    const { note, mark } = RUNS_CODE.get(kinds[0][0])
    const at = opensAt(path, path === undefined ? undefined : onlyLine(kinds.map(([, lines]) => lines)))
    return html`<span data-bundle-view-source=${at.path} data-bundle-view-line=${at.line}
      class=${`npm-runs-code${mark ? ` is-${mark}` : ''}`} data-tooltip=${`${note}: ${parts.join('; ')}`}>${tag}</span>`
  })
}
