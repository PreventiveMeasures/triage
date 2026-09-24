import { LitElement, css, html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'

// Shared presentation and keyboard behavior for repository, user, and bundle pickers.
// Subclasses provide choices and labels; consumers own data and selection.
export class SearchableSelector extends LitElement {
  static properties = {
    options: { attribute: false }, value: { attribute: false },
    label: { type: String }, placeholder: { type: String }, disabled: { type: Boolean },
    _query: { state: true }, _facet: { state: true }, _open: { state: true },
  }

  static styles = css`
    :host { display: block; min-width: 0; }
    * { box-sizing: border-box; }
    button, input { font: inherit; color: var(--text); }
    button { cursor: default; user-select: none; }
    .trigger { display: flex; align-items: center; gap: .6rem; width: 100%; height: 2rem; padding: .28rem .5rem; border: 1px solid var(--border); border-radius: 5px; background: var(--bg); text-align: left; font-size: .76rem; }
    .trigger:hover:not(:disabled) { border-color: var(--muted); }
    .trigger:disabled { opacity: .5; }
    :host([variant=filter]) { display: inline-block; max-width: min(20rem, 100%); }
    :host([variant=filter]) .trigger { height: 30px; min-width: 8.5rem; background: transparent; font-size: .8rem; font-weight: 500; border-radius: 4px; }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .option-copy { flex: 1; min-width: 0; display: grid; gap: .08rem; }
    .secondary { color: var(--muted); font-size: .64rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .avatar { display: grid; place-items: center; flex: 0 0 1.5rem; width: 1.5rem; height: 1.5rem; border-radius: 50%; color: var(--accent); background: rgb(from var(--accent) r g b / .13); font-family: sans-serif; font-size: .62rem; font-weight: 600; }
    .detail, .count { flex: 0 0 auto; color: var(--muted); font-size: .66rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
    svg { flex: 0 0 auto; width: .9rem; height: .9rem; color: var(--muted); }
    .menu { visibility: hidden; position: fixed; inset: auto; margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); box-shadow: 0 .6rem 1.6rem rgb(0 0 0 / .4); user-select: none; }
    .menu:popover-open { display: flex; flex-direction: column; }
    .menu[data-positioned] { visibility: visible; }
    .search { display: flex; align-items: center; gap: .5rem; flex: 0 0 auto; padding: .55rem .65rem; border-bottom: 1px solid var(--border); }
    input { flex: 1; min-width: 0; width: 0; padding: .15rem 0; border: 0; background: transparent; font-size: .78rem; outline: none; }
    input::placeholder { color: var(--muted); }
    .search:focus-within { box-shadow: inset 0 -2px var(--accent); }
    .body { display: flex; min-height: 0; flex: 1; }
    .facets { width: 10.5rem; flex: 0 0 auto; padding: .35rem; overflow: auto; overscroll-behavior: none; border-right: 1px solid var(--border); background: rgb(from var(--bg) r g b / .25); }
    .org { display: flex; align-items: center; gap: .4rem; width: 100%; padding: .4rem .45rem; border: 0; border-radius: 4px; background: transparent; text-align: left; font-size: .7rem; }
    .org[aria-pressed=true] { color: var(--accent); background: rgb(from var(--accent) r g b / .1); }
    .results { flex: 1; min-width: 0; overflow: auto; overscroll-behavior: none; padding: .3rem; }
    .group + .group { margin-top: .35rem; padding-top: .35rem; border-top: 1px solid var(--border); }
    .heading { position: sticky; top: -.3rem; z-index: 1; display: flex; align-items: center; gap: .4rem; margin: 0; padding: .4rem .5rem; color: var(--muted); background: var(--bg); font-size: .68rem; font-weight: 600; }
    .heading svg { width: .8rem; height: .8rem; }
    .option { display: flex; align-items: center; gap: .65rem; width: 100%; padding: .35rem .5rem; border: 0; border-radius: 4px; background: transparent; text-align: left; font-size: .76rem; }
    .option svg { width: .8rem; height: .8rem; opacity: 0; color: var(--accent); }
    .option[aria-selected=true] { color: var(--accent); background: rgb(from var(--accent) r g b / .1); }
    .option[aria-selected=true] svg { opacity: 1; }
    .option:disabled { opacity: .45; }
    .option:hover:not(:disabled), .org:hover { background: rgb(from var(--text) r g b / .05); }
    .pinned { padding-bottom: .25rem; margin-bottom: .25rem; border-bottom: 1px solid var(--border); }
    .empty { margin: 0; padding: 1.3rem .7rem; color: var(--muted); font-size: .76rem; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    @media (max-width: 40rem) { .facets { width: 8.5rem; } }
    @media (max-width: 28rem) { .facets { width: 7rem; } .option { gap: .35rem; } }
  `

  constructor() {
    super()
    this.options = []
    this.value = null
    this.label = 'Choose'
    this.placeholder = 'Choose'
    this.disabled = false
    this._query = ''
    this._facet = null
    this._open = false
    this._menuHeight = null
    this._onViewport = () => this._position()
  }

  connectedCallback() {
    super.connectedCallback()
    window.addEventListener('resize', this._onViewport)
    window.addEventListener('scroll', this._onViewport, true)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    window.removeEventListener('resize', this._onViewport)
    window.removeEventListener('scroll', this._onViewport, true)
  }

  render() {
    const selected = this.options.find(option => option.value === this.value)
    const choices = this.choices()
    const visible = [...choices.pinned, ...choices.sections.flatMap(section => section.options)]
    const enabled = visible.filter(option => !option.disabled)
    const tabValue = enabled.find(option => option.value === this.value)?.value ?? enabled[0]?.value
    return html`<button type="button" class="trigger" popovertarget="selector-menu" aria-label=${this.label} aria-haspopup="dialog" aria-expanded=${this._open} ?disabled=${this.disabled}>
      ${selected ? this.optionIcon(selected) : nothing}<span class="name">${selected?.label ?? this.placeholder}</span>${selected?.detail ? html`<span class="detail">${selected.detail}</span>` : nothing}
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
    </button><div class="menu" id="selector-menu" popover="auto" role="dialog" aria-label=${this.label} @beforetoggle=${this._beforeToggle} @toggle=${this._toggle} @keydown=${this._keyDown}>
      <div class="search"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/></svg>
        <input type="search" placeholder=${`${this.searchLabel}…`} aria-label=${this.searchLabel} aria-controls="selector-options" .value=${live(this._query)} @input=${event => { this._query = event.target.value }}>
        <span class="count" role="status">${choices.count}${choices.count === choices.total ? '' : ` / ${choices.total}`}</span>
      </div><div class="body">
        ${choices.showFacets ? html`<div class="facets" role="group" aria-label=${this.facetLabel}>
          <button type="button" class="org" aria-pressed=${choices.activeFacet == null} @click=${() => this._filterFacet(null)}><span class="name">${this.allFacetsLabel}</span><span class="count">${choices.total}</span></button>
          ${choices.facets.map(org => html`<button type="button" class="org" title=${org.name} aria-pressed=${choices.activeFacet === org.value} @click=${() => this._filterFacet(org.value)}><span class="name">${org.name}</span><span class="count">${org.count}</span></button>`)}
        </div>` : nothing}
        <div class="results" id="selector-options" role="listbox" aria-label=${this.optionsLabel}>
          ${choices.pinned.length > 0 ? html`<div class="pinned">${choices.pinned.map(option => this._option(option, false, tabValue))}</div>` : nothing}
          ${choices.sections.map((section, index) => html`<div class="group" role="group" aria-labelledby=${section.label ? `selector-group-${index}` : nothing}>
            ${section.label ? html`<h3 class="heading" id=${`selector-group-${index}`}>${section.organization ? html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M3 14V3h6v11M9 7h4v7M1 14h14M5 6h2M5 9h2M5 12h2"/></svg>` : nothing}${section.label}</h3>` : nothing}
            ${section.options.map(option => this._option(option, section.organization, tabValue))}
          </div>`)}
          ${choices.count ? nothing : html`<p class="empty">${this.options.length > 0 ? this.noMatchesLabel : this.emptyLabel}</p>`}
        </div>
      </div>
    </div>`
  }

  optionIcon(_option) { return nothing }
  optionTitle(option) { return option.label }

  _option(option, grouped, tabValue) {
    return html`<button type="button" class="option" role="option" ?data-reset=${option.reset} ?disabled=${option.disabled} aria-label=${option.label} title=${this.optionTitle(option)} aria-selected=${option.value === this.value} tabindex=${option.value === tabValue ? 0 : -1} @click=${() => this._pick(option.value)}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>${this.optionIcon(option)}${option.initials ? html`<span class="avatar" aria-hidden="true">${option.initials}</span>` : nothing}<span class="option-copy"><span class="name">${option.displayLabel ?? (grouped ? option.name : option.label)}</span>${option.secondary ? html`<span class="secondary">${option.secondary}</span>` : nothing}</span>${option.detail ? html`<span class="detail">${option.detail}</span>` : nothing}
    </button>`
  }

  updated(changed) {
    if (this.disabled && this._open) this._close(false)
    if (changed.has('options')) this._menuHeight = null
    this._position()
    if (changed.has('_query') || changed.has('_facet')) this.renderRoot.querySelector('.results').scrollTop = 0
  }

  _beforeToggle(event) {
    this._open = event.newState === 'open'
    delete event.target.dataset.positioned
    if (this._open) { this._query = ''; this._facet = null; this._menuHeight = null }
  }

  async _toggle(event) {
    if (event.newState !== 'open') return
    await this.updateComplete
    if (!this._open || !this.isConnected) return
    this._position()
    this.renderRoot.querySelector('input').focus({ preventScroll: true })
  }

  _position() {
    const menu = this.renderRoot.querySelector('.menu')
    if (!menu?.matches(':popover-open')) return
    const rect = this.renderRoot.querySelector('.trigger').getBoundingClientRect()
    const margin = 8
    const wide = menu.querySelector('.facets') != null
    const width = Math.min(Math.max(rect.width, wide ? 560 : 360), window.innerWidth - margin * 2)
    const below = window.innerHeight - rect.bottom - margin - 4
    const above = rect.top - margin - 4
    menu.style.width = `${width}px`
    // Keep the search field and results stable while filtering. A short list
    // still sizes to its contents; long lists scroll inside the top layer.
    this._menuHeight ??= Math.min(480, menu.querySelector('.search').offsetHeight + Math.max(
      menu.querySelector('.results').scrollHeight,
      menu.querySelector('.facets')?.scrollHeight ?? 0,
    ) + 2)
    const desired = this._menuHeight
    const upward = below < desired && above > below
    menu.style.maxHeight = `${Math.max(0, Math.min(desired, upward ? above : below))}px`
    menu.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`
    menu.style.top = `${Math.max(margin, upward ? rect.top - menu.offsetHeight - 4 : rect.bottom + 4)}px`
    menu.dataset.positioned = ''
  }

  _filterFacet(name) {
    this._facet = name
    this.renderRoot.querySelector('input').focus({ preventScroll: true })
  }

  _keyDown(event) {
    event.stopPropagation() // Popup keys must not navigate the underlying Findings view.
    if (event.key === 'Escape') { event.preventDefault(); this._close(); return }
    const input = this.renderRoot.querySelector('input')
    const active = this.renderRoot.activeElement
    const options = [...this.renderRoot.querySelectorAll('.option:not(:disabled)')]
    const index = options.indexOf(active)
    if (active !== input && index < 0) return
    if (event.key === 'Enter' && active === input) {
      event.preventDefault()
      // Prefer a search result to the pinned reset option.
      const first = this.renderRoot.querySelector('.option:not([data-reset]):not(:disabled)') ?? options[0]
      first?.click()
      return
    }
    let next
    if (event.key === 'ArrowDown') next = Math.min(index + 1, options.length - 1)
    else if (event.key === 'ArrowUp') next = index - 1
    else if (active !== input && event.key === 'Home') next = 0
    else if (active !== input && event.key === 'End') next = options.length - 1
    else if (active !== input && event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); this._query += event.key; input.focus(); return
    } else return
    event.preventDefault()
    for (const [i, option] of options.entries()) option.tabIndex = i === next ? 0 : -1
    if (next < 0) input.focus()
    else options[next]?.focus()
  }

  _pick(value) {
    if (this.disabled || !this.options.some(option => option.value === value && !option.disabled)) return
    this._close()
    this.dispatchEvent(new CustomEvent(this.changeEvent, { detail: { value }, bubbles: true, composed: true }))
  }

  _close(focus = true) {
    this.renderRoot.querySelector('.menu').hidePopover()
    this._open = false
    if (focus) this.renderRoot.querySelector('.trigger').focus({ preventScroll: true })
  }
}
