// Dynamic tag names are resolved by Lit, before HTML minification can apply.
import { literal, html as staticTemplate } from 'lit/static-html.js'
import { COMBINED_DIFF_MAX, combinedDiffRows } from './bundle-compare-all.js'

// This is the only place that wires a comparison source into a file viewer.
// New source features belong here and reach both pages and both display modes.
export function renderComparisonViewer({ base, other, diff, source, path, baseName, otherName, select, extensions = null, mode }) {
  // Review has already chosen from source size. Compare counts rendered rows
  // once, retaining those diff models for the viewer.
  const combined = mode ? null : diff.combined ??= combinedDiffRows(base, other, diff.files, { resolutions: diff.resolutions?.changed ?? [] })
  mode ??= combined.rows < COMBINED_DIFF_MAX ? 'diff' : 'code'
  const tag = mode === 'diff' ? literal`bundle-compare-all` : literal`bundle-compare-code`
  return staticTemplate`<${tag} .base=${base} .other=${other} .files=${diff.files} .resolutions=${diff.resolutions?.changed ?? []}
    .baseAlerts=${source?.files?.alerts?.(base) ?? null} .otherAlerts=${source?.files?.alerts?.(other) ?? null} .alertTags=${source?.files?.alertTags ?? null}
    .dependencies=${source?.dependencies?.(base, other) ?? null} .openDependency=${source?.openDependency ?? null} .dependencyTags=${source?.dependencyTags ?? null}
    .models=${combined?.models ?? null} .path=${path} .extensions=${extensions} baseName=${baseName} otherName=${otherName}
    @compare-code-select=${event => { event.stopPropagation(); select(event.detail.path) }}></${tag}>`
}
