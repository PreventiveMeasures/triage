import { nothing } from 'lit'
import { TAGS_FIT } from './bundle-selector.js'

// Both selects share a width, initially fitting the widest name or placeholder,
// then every loaded choice and as many of its smaller tags as fit TAGS_FIT.
// Menus size themselves.
export function comparePickerStyle(source) {
  if (!source) return nothing
  const fit = ({ name = '', detail = '' } = {}) => name.length + Math.min(detail.length, TAGS_FIT) * .87 + 1
  const chars = (source.choices ?? []).reduce((most, choice) => Math.max(most, fit(choice)), Math.max(`Choose a ${source.noun ?? 'bundle'}…`.length, fit(source.widest)))
  return `--compare-select-chars: ${Math.ceil(chars)}`
}
