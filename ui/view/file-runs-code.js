// What a file's code can do beyond itself, as risk tells it
// (risk/files/runs-code.js), as the npm Overview's Files list and Compare
// label a file: its tags, their tooltips, and each version's files read once.
import { html, nothing } from 'lit'
import { RUNS_CODE } from '../../risk/files/runs-code.js'
import { NPM_MAX_FOUND } from '../../risk/files/script.js'
import { fileRiskOf } from './file-risk.js'

export { npmRunsCodeKinds } from '../../risk/files/runs-code.js'

// What a version's file runs beyond itself, as risk read it (file-risk.js
// fileRiskOf).
export const npmFileRunsCode = (details, path) => fileRiskOf(details, path).runsCode

// Its first lines, and how many more: some more yet where as many as risk
// keeps were found (NPM_MAX_FOUND).
export const linesNote = lines => lines.length === 1 ? `line ${lines[0]}`
  : `lines ${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ` and ${(lines.length - 5).toLocaleString('en')}${lines.length >= NPM_MAX_FOUND ? '+' : ''} more` : ''}`

// The kinds a file holds, each with its lines, those new to it (`added`, by
// kind) so said: by its own name where that is code, as eval's kin and
// child_process are (`eval (line 3), Function (line 5, new)`), else by its
// tag, kinds sharing one as one (`shell (line 4), credentials (lines 2,
// 7)`), as the tag's own tooltip spells out what it covers (npmRunsCodeTags).
const CODE_NAME = /^[\w$.]+$/u
export const npmRunsCodeSaid = (found, added = null) => [...Map.groupBy([...found], ([kind]) => {
  const { name, tag } = RUNS_CODE.get(kind)
  return name && CODE_NAME.test(name) ? name : tag
})].map(([said, kinds]) => `${said} (${linesNote([...new Set(kinds.flatMap(([, lines]) => lines))].toSorted((a, b) => a - b))}${kinds.some(([kind]) => added?.has(kind)) ? ', new' : ''})`).join(', ')

// The one line a tag's lines (each kind's, or service's) are, undefined for
// several: where a click on the tag opens its file.
export const onlyLine = lineLists => {
  const lines = new Set(lineLists.flat())
  return lines.size === 1 ? [...lines][0] : undefined
}

// A tag's attributes opening `path` in the code viewer at `line`
// (`data-bundle-view-source`, events.js), scrolled to it: none without one.
export const opensAt = (path, line) => line === undefined ? { path: nothing, line: nothing } : { path, line }

// A file's tags, one for the kinds it holds (npmRunsCode) that share it, its
// tooltip a list as Compare's chips' are: what the tag tells, then a row for
// each kind, its name and lines; with `was`, the kinds the file held as the
// version compared with has it (null for none), those it didn't hold named
// in a line under them, `New in this version`; with `path`, for a list whose
// rows open the file, a tag on one line opening it there.
export function npmRunsCodeTags(found, was, path) {
  if (!found) return nothing
  return [...Map.groupBy(found, ([kind]) => RUNS_CODE.get(kind).tag)].map(([tag, kinds]) => {
    const { note, mark } = RUNS_CODE.get(kinds[0][0])
    const rows = kinds.map(([kind, lines]) => [RUNS_CODE.get(kind).name, linesNote(lines)])
    const added = was === undefined ? [] : kinds.filter(([kind]) => !was?.has(kind)).map(([kind]) => RUNS_CODE.get(kind).name)
    const notice = added.length === 0 ? null : added.length === kinds.length ? 'New in this version' : `New in this version: ${added.join(', ')}`
    const at = opensAt(path, path === undefined ? undefined : onlyLine(kinds.map(([, lines]) => lines)))
    return html`<span data-bundle-view-source=${at.path} data-bundle-view-line=${at.line}
      class=${`npm-runs-code${mark ? ` is-${mark}` : ''}`} data-tooltip=${[`${note}: ${rows.map(row => row.join(', ')).join('; ')}`, notice].filter(Boolean).join(' · ')}
      .tooltipContent=${html`<div class="compare-tip">
        <div class="compare-tip-head">${note}</div>
        <div class="compare-tip-rows is-files">${rows.map(([name, lines]) => html`<span class="compare-tip-path">${name}</span><span class="compare-tip-said">${lines}</span>`)}</div>
        ${notice ? html`<div class="compare-tip-notice">${notice}</div>` : nothing}
      </div>`}>${tag}</span>`
  })
}
