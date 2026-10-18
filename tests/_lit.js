// Lit templates as tests read them.
import { guard } from 'lit/directives/guard.js'
import { styleMap } from '../ui/view/style-map.js'

// `styleMap`'s and `guard`'s directives, to know their results by.
const STYLE_MAP = styleMap({})['_$litDirective$']
const GUARD = guard([], () => null)['_$litDirective$']

// Whether a value is a `guard`'s result, and what it draws: its function's.
export const isGuard = value => value?.['_$litDirective$'] === GUARD
export const guarded = value => value.values[1]()

// The items `repeat` draws, each through its template: a directive's result
// of an iterable and a template (after a key, where given); null for any
// other, a `guard`'s too.
function repeated(value) {
  const [items, key, template = key] = value?.['_$litDirective$'] && !isGuard(value) ? value.values : []
  return items && typeof items !== 'string' && typeof items[Symbol.iterator] === 'function' && typeof template === 'function'
    ? [...items].map((item, i) => template(item, i)) : null
}

// A template's text, its values spelled out in place: arrays joined, and
// `repeat`'s items, a `guard`'s; a `styleMap`'s declarations as `name: value; …`;
// `nothing` and other symbols, null and undefined as none, anything else
// as String() gives it.
export const templateText = value => Array.isArray(value) ? value.map(templateText).join('')
  : value?.strings ? value.strings.map((part, i) => part + templateText(value.values[i])).join('')
  : value?.['_$litDirective$'] === STYLE_MAP ? Object.entries(value.values[0]).filter(([, set]) => set != null && set !== '').map(([name, set]) => `${name}: ${set}`).join('; ')
  : isGuard(value) ? templateText(guarded(value))
  : repeated(value) ? templateText(repeated(value))
  : typeof value === 'symbol' ? '' : String(value ?? '')

// Every template in a value, depth first: those it holds in arrays and
// values too, and a `guard` draws.
export function templates(value) {
  if (Array.isArray(value)) return value.flatMap(templates)
  if (isGuard(value)) return templates(guarded(value))
  return value?.strings ? [value, ...value.values.flatMap(templates)] : []
}
