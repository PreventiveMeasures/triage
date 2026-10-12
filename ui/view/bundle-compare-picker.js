import { nothing } from 'lit'
// A choice’s tags are cut short beyond this width.
const TAGS_FIT = 24

// Adapt a comparison source's choices for bundle-selector without losing its
// release dates or warnings. Review uses package-qualified values for its base.
export function compareSourceOptions(options, valueOf = option => option.id) {
  return options.map(option => ({ id: valueOf(option), integrity: valueOf(option), kind: option.format, format: option.format,
    detail: option.detail, ...option.date && { date: option.date }, ...option.dateWarning && { dateWarning: option.dateWarning },
    filename: option.name, displayLabel: option.displayLabel, size: '—', summary: null }))
}

// Both selects share a width, initially fitting the widest name or placeholder,
// then every loaded choice and as many of its smaller tags as fit TAGS_FIT.
// Menus size themselves.
export function comparePickerStyle(source) {
  if (!source) return nothing
  const fit = ({ name = '', detail = '' } = {}) => name.length + Math.min(detail.length, TAGS_FIT) * .87 + 1
  const chars = (source.choices ?? []).reduce((most, choice) => Math.max(most, fit(choice)), Math.max(`Choose a ${source.noun ?? 'bundle'}…`.length, fit(source.widest)))
  return `--compare-select-chars: ${Math.ceil(chars)}`
}
