// Lit templates as tests read them.

// The items `repeat` draws, each through its template: a directive's result
// of an iterable and a template (after a key, where given); null for any
// other.
function repeated(value) {
  const [items, key, template = key] = value?.['_$litDirective$'] ? value.values : []
  return items && typeof items !== 'string' && typeof items[Symbol.iterator] === 'function' && typeof template === 'function'
    ? [...items].map((item, i) => template(item, i)) : null
}

// A template's text, its values spelled out in place: arrays joined, and
// `repeat`'s items; `nothing` and other symbols, null and undefined as none,
// anything else as String() gives it.
export const templateText = value => Array.isArray(value) ? value.map(templateText).join('')
  : value?.strings ? value.strings.map((part, i) => part + templateText(value.values[i])).join('')
  : repeated(value) ? templateText(repeated(value))
  : typeof value === 'symbol' ? '' : String(value ?? '')

// Every template in a value, depth first: those it holds in arrays and
// values too.
export function templates(value) {
  if (Array.isArray(value)) return value.flatMap(templates)
  return value?.strings ? [value, ...value.values.flatMap(templates)] : []
}
