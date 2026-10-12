// Dynamic tag names are resolved by Lit, before HTML minification can apply.
import { literal, html as staticTemplate } from 'lit/static-html.js'
import { COMBINED_DIFF_MAX, combinedDiffRows } from './bundle-compare-all.js'
import { comparisonFileList, withinComparisonLimits } from './bundle-compare-files.js'

// Cache sizing and any diff models computed for it alongside the comparison.
// Review supplies its existing byte/line limits; Compare counts rendered rows.
export function comparisonPresentation(base, other, diff, { maxRows = COMBINED_DIFF_MAX, maxBytes = Infinity, maxLines = Infinity } = {}) {
  const key = `${maxRows}:${maxBytes}:${maxLines}`
  const cached = diff.presentations ??= new Map()
  if (cached.has(key)) return cached.get(key)
  let result = { mode: 'code', models: null }
  if ((maxBytes === Infinity && maxLines === Infinity) || withinComparisonLimits(comparisonFileList(base, other, diff), { maxBytes, maxLines })) {
    const combined = maxRows === Infinity ? { rows: 0, models: null }
      : combinedDiffRows(base, other, diff.files, { resolutions: diff.resolutions?.changed ?? [], max: maxRows })
    result = { ...combined, mode: combined.rows < maxRows ? 'diff' : 'code' }
  }
  cached.set(key, result)
  return result
}

// This is the only place that wires a comparison source into a file viewer.
// New source features belong here and reach both pages and both display modes.
export function renderComparisonViewer({ base, other, diff, source, path, baseName, otherName, select, extensions = null, limits }) {
  const { mode, models } = comparisonPresentation(base, other, diff, limits)
  const tag = mode === 'diff' ? literal`bundle-compare-all` : literal`bundle-compare-code`
  return staticTemplate`<${tag} .base=${base} .other=${other} .files=${diff.files} .resolutions=${diff.resolutions?.changed ?? []}
    .baseAlerts=${source?.files?.alerts?.(base) ?? null} .otherAlerts=${source?.files?.alerts?.(other) ?? null} .alertTags=${source?.files?.alertTags ?? null}
    .dependencies=${source?.dependencies?.(base, other) ?? null} .openDependency=${source?.openDependency ?? null} .dependencyTags=${source?.dependencyTags ?? null}
    .models=${models} .path=${path} .extensions=${extensions} baseName=${baseName} otherName=${otherName}
    @compare-code-select=${event => { event.stopPropagation(); select(event.detail.path) }}></${tag}>`
}
