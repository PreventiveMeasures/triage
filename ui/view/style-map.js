// `styleMap` for pages that take no inline style. Lit's own sets an
// element's first styles as a `style` attribute string, which
// `style-src 'self'` refuses, and writes through the CSSOM only on the
// renders after; this one writes through the CSSOM from the first, so the
// first paint is styled too. Used as Lit's is: `style=${styleMap({ … })}`,
// the whole of the attribute; a null or undefined value removes its
// property, a value ending in `!important` sets it important.
import { noChange } from 'lit'
import { Directive, PartType, directive } from 'lit/directive.js'

const IMPORTANT = '!important'

class CSSOMStyleMap extends Directive {
  constructor(partInfo) {
    super(partInfo)
    // Nothing beside it in the attribute, not even the `/` of a `/>` it
    // runs into unquoted, which would be set as the attribute's text.
    if (partInfo.type !== PartType.ATTRIBUTE || partInfo.name !== 'style' || partInfo.strings?.length > 2 || partInfo.strings?.some(text => text !== '')) {
      throw new Error('`styleMap` must be the whole of a `style` attribute.')
    }
    this.shown = new Set()
  }

  render() {
    return noChange
  }

  update(part, [styles]) {
    const { style } = part.element
    for (const name of this.shown) {
      if (styles[name] != null) continue
      this.shown.delete(name)
      if (name.includes('-')) style.removeProperty(name)
      else style[name] = null
    }
    for (const [name, value] of Object.entries(styles)) {
      if (value == null) continue
      this.shown.add(name)
      const important = typeof value === 'string' && value.endsWith(IMPORTANT)
      if (name.includes('-') || important) style.setProperty(name, important ? value.slice(0, -IMPORTANT.length) : value, important ? 'important' : '')
      else style[name] = value
    }
    return noChange
  }
}

export const styleMap = directive(CSSOMStyleMap)
