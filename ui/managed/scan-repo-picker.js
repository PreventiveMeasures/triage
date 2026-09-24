import { LitElement, css, html } from 'lit'

class ScanRepoPicker extends LitElement {
  static properties = {
    repositories: { attribute: false }, bundles: { attribute: false }, value: { attribute: false },
  }

  static styles = css`
    :host { display: block; min-width: 0; }
    * { box-sizing: border-box; }
    button { font: inherit; color: var(--text); cursor: default; user-select: none; }
    .trigger { display: flex; align-items: center; gap: .6rem; width: 100%; height: 2rem; padding: .28rem .5rem; border: 1px solid var(--border); border-radius: 5px; background: var(--bg); text-align: left; font-size: .72rem; }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count { flex: 0 0 auto; color: var(--muted); font-size: .65rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
    svg { flex: 0 0 auto; width: .8rem; height: .8rem; color: var(--muted); }
    .menu { position: fixed; inset: auto; margin: 0; padding: .25rem; overflow: auto; overscroll-behavior: contain; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-active); color: var(--text); box-shadow: 0 .4rem 1.2rem rgb(0 0 0 / .35); }
    .option { display: flex; align-items: center; gap: 1rem; width: 100%; min-height: 2rem; padding: .35rem .5rem; border: 0; border-radius: 4px; background: transparent; text-align: left; font-size: .72rem; }
    .option:hover { background: rgb(from var(--text) r g b / .05); }
    .option[aria-selected=true] { color: var(--accent); background: rgb(from var(--accent) r g b / .1); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  `

  constructor() {
    super()
    this.repositories = []
    this.bundles = []
    this.value = null
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
    const counts = new Map()
    for (const bundle of this.bundles) counts.set(bundle.repoId, (counts.get(bundle.repoId) ?? 0) + 1)
    const selected = this.repositories.find(repo => repo.id === this.value)
    const count = id => { const n = counts.get(id) ?? 0; return `${n} ${n === 1 ? 'bundle' : 'bundles'}` }
    return html`<button type="button" class="trigger" popovertarget="repositories" aria-label="Choose repository" aria-haspopup="listbox">
      <span class="name">${selected?.label ?? 'Choose repository'}</span><span class="count">${count(this.value)}</span>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
    </button><div class="menu" id="repositories" popover="auto" role="listbox" aria-label="Repositories" @toggle=${this._toggle} @keydown=${this._keyDown}>
      ${this.repositories.map(repo => html`<button type="button" class="option" role="option" aria-selected=${repo.id === this.value} tabindex=${repo.id === this.value ? 0 : -1} @click=${() => this._pick(repo.id)}>
        <span class="name">${repo.label}</span><span class="count">${count(repo.id)}</span>
      </button>`)}
    </div>`
  }

  updated() { this._position() }

  _toggle(event) {
    const open = event.newState === 'open'
    this.renderRoot.querySelector('.trigger').setAttribute('aria-expanded', String(open))
    if (open) {
      this._position()
      const menu = event.target
      const selected = menu.querySelector('[aria-selected=true]') ?? menu.querySelector('.option')
      for (const option of menu.querySelectorAll('.option')) option.tabIndex = option === selected ? 0 : -1
      selected?.focus({ preventScroll: true })
      selected?.scrollIntoView({ block: 'nearest' })
    }
  }

  _position() {
    const menu = this.renderRoot.querySelector('.menu')
    if (!menu?.matches(':popover-open')) return
    const rect = this.renderRoot.querySelector('.trigger').getBoundingClientRect()
    const margin = 8
    const width = Math.min(Math.max(rect.width, 240), window.innerWidth - margin * 2)
    const below = window.innerHeight - rect.bottom - margin - 4
    const above = rect.top - margin - 4
    menu.style.width = `${width}px`
    const upward = below < Math.min(menu.scrollHeight, 240) && above > below
    menu.style.maxHeight = `${Math.max(0, Math.min(400, upward ? above : below))}px`
    menu.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`
    menu.style.top = `${Math.max(margin, upward ? rect.top - menu.offsetHeight - 4 : rect.bottom + 4)}px`
  }

  _keyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      this._close()
      return
    }
    const options = [...this.renderRoot.querySelectorAll('.option')]
    const index = options.indexOf(this.renderRoot.activeElement)
    let next
    if (event.key === 'ArrowDown') next = (index + 1) % options.length
    else if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = options.length - 1
    else return
    event.preventDefault()
    for (const [i, option] of options.entries()) option.tabIndex = i === next ? 0 : -1
    options[next]?.focus()
  }

  _pick(id) {
    this.dispatchEvent(new CustomEvent('repository-change', { detail: { id }, bubbles: true, composed: true }))
    this._close()
  }

  _close() {
    this.renderRoot.querySelector('.menu').hidePopover()
    this.renderRoot.querySelector('.trigger').focus({ preventScroll: true })
  }
}

customElements.define('scan-repo-picker', ScanRepoPicker)
