// Lit templates as tests read them.

// A template's text, its values spelled out in place: arrays joined,
// `nothing` and other symbols, null and undefined as none, anything else as
// String() gives it.
export const templateText = value => Array.isArray(value) ? value.map(templateText).join('')
  : value?.strings ? value.strings.map((part, i) => part + templateText(value.values[i])).join('')
  : typeof value === 'symbol' ? '' : String(value ?? '')

// Every template in a value, depth first: those it holds in arrays and
// values too.
export function templates(value) {
  if (Array.isArray(value)) return value.flatMap(templates)
  return value?.strings ? [value, ...value.values.flatMap(templates)] : []
}
