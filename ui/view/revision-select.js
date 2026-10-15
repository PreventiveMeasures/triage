// A revision of a repository: a branch, a tag or a commit, its kind switched
// by the buttons before it, its name typed or picked among the repository's
// (`refs`: `{ defaultBranch, branches, tags }`). Shared by Create a bundle
// (ui/managed/repository-browser.js) and the code viewer's header
// (repository-code.js). The host owns `kind` and `name`: each change is a
// `revision-change` event, `detail.how` saying what made it: `kind` (a kind
// picked, `name` the default branch for a branch, else ''), `input` (typed),
// `pick` (a suggestion picked) or `submit` (Enter with none active).
import { LitElement, css, html, nothing } from 'lit'
import { ifDefined } from 'lit/directives/if-defined.js'
import { live } from 'lit/directives/live.js'

export const commitIcon = html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M1 8h4m6 0h4"/></svg>`
const chevronIcon = html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>`

const REVISION_TYPES = [
  { kind: 'branch', label: 'Branch', icon: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><circle cx="12" cy="3" r="1.5"/><path d="M4 4.5v7m0-3h3a5 5 0 0 0 5-4"/></svg>` },
  { kind: 'tag', label: 'Tag', icon: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M2 2h5.5l6.5 6.5-5.5 5.5L2 7.5Z"/><circle cx="5" cy="5" r="1"/></svg>` },
  { kind: 'commit', label: 'Commit SHA', icon: commitIcon },
]

const VERSION = /^v?(\d+(?:\.(?:\d+|x))*)(?:[-+](.+))?$/iu

// Release lines (v22.x, 3.12), other versions (v22.x-staging), or the rest.
function branchKind(name) {
  const match = VERSION.exec(name)
  if (!match) return 'other'
  return match[2] === undefined ? 'line' : 'version'
}

// Version-like branches (v22.x, 3.12, v22.x-staging) lead, newest line first,
// plain lines before suffixed ones so each reads as one run. The rest keep
// GitHub's order after them.
function orderBranches(names) {
  const keyed = names.map(name => {
    const match = VERSION.exec(name)
    return { name, parts: match?.[1].split('.').map(part => part.toLowerCase() === 'x' ? Infinity : Number(part)), suffix: match?.[2] ?? '' }
  })
  const compare = (a, b) => {
    if (Boolean(a.suffix) !== Boolean(b.suffix)) return a.suffix ? 1 : -1
    // A missing part or `x` names the whole line, above its releases.
    for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
      const diff = (b.parts[i] ?? Infinity) - (a.parts[i] ?? Infinity)
      if (diff) return diff
    }
    return a.suffix.localeCompare(b.suffix)
  }
  return [...keyed.filter(item => item.parts).toSorted(compare), ...keyed.filter(item => !item.parts)].map(item => item.name)
}

// Branches sharing a first path segment collapse under it when there are more
// than two of them, listed after the other branches. An expanded prefix lists
// its branches without the prefix. The default branch stays outside any group.
function groupBranches(names, expanded, defaultBranch) {
  const prefix = name => name === defaultBranch || !name.includes('/') ? null : name.slice(0, name.indexOf('/'))
  const groups = Map.groupBy(names.filter(prefix), prefix)
  const entries = names.filter(name => !(groups.get(prefix(name))?.length > 2)).map(name => ({ name }))
  for (const [key, members] of groups) {
    if (members.length <= 2) continue
    entries.push({ prefix: key, count: members.length, expanded: expanded.has(key) })
    if (expanded.has(key)) entries.push(...orderBranches(members.map(name => name.slice(key.length + 1))).map(label => ({ name: `${key}/${label}`, label, group: key })))
  }
  return entries
}

export class RevisionSelect extends LitElement {
  static properties = {
    refs: { attribute: false }, kind: { type: String }, name: { type: String }, disabled: { type: Boolean },
    installTooltips: { attribute: false },
    _open: { state: true }, _query: { state: true }, _active: { state: true }, _expanded: { state: true }, _keyboard: { state: true },
  }

  static styles = css`
    :host { display: block; min-width: 0; }
    :host, .revision-menu { -webkit-app-region: no-drag; app-region: no-drag; }
    * { box-sizing: border-box; }
    button, input { font: inherit; color: var(--text); }
    button { cursor: default; user-select: none; }
    .revision {
      display: flex; align-items: center; min-width: 0; height: 2rem; margin: 0;
      border: 1px solid var(--border); border-radius: var(--ui-radius, 5px); background: var(--bg);
    }
    /* Its ring shows where the keyboard moved focus into it, as the
       repository picker's does, not where a pointer did. */
    .revision.keyboard:focus-within { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    /* The name as wide as it is, a full commit's included, as far as the
       host lets it (its widest is its max-content), else as the host is,
       down to as narrow as the host's least, the name then clipped as an
       input clips it: its track sized by the name, never at least by it. */
    .revision-size { display: grid; grid-template-columns: minmax(0, 1fr); flex: 1 1 auto; align-self: stretch; min-width: 0; }
    .revision-size > input, .revision-size::after { grid-area: 1 / 1; }
    .revision-size > input { width: 100%; }
    .revision-size::after {
      content: attr(data-value); visibility: hidden; height: 0; overflow: hidden; white-space: pre;
      min-width: 8rem; padding: 0 calc(.6rem + 2px) 0 .6rem; font-size: .76rem;
    }
    .revision input {
      height: 100%; min-height: 0; padding: .3rem .6rem; min-width: 0; border: 0; border-radius: 0;
      background: transparent; color: var(--text); font-size: .76rem;
    }
    .revision input:focus-visible { outline: none; }
    .revision-switch {
      display: flex; flex: none; align-self: stretch; padding: 2px; gap: 2px;
    }
    .revision-switch button {
      display: grid; place-items: center; width: 1.8rem; padding: 0; border: 0; border-radius: var(--ui-radius, 3px);
      background: transparent; color: var(--muted);
    }
    .revision-switch button:hover:not(:disabled) { color: var(--text); background: var(--surface-active); }
    .revision-switch button:focus-visible { outline-offset: -2px; }
    .revision-switch button[aria-pressed=true] { color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, var(--bg)); }
    .revision-switch svg { width: 1rem; height: 1rem; }
    .revision-expand {
      display: grid; place-items: center; align-self: stretch; flex: none; width: 2rem; padding: 0;
      border: 0; border-radius: var(--ui-radius, 4px); color: var(--muted); background: transparent;
    }
    .revision-expand svg { width: .9rem; height: .9rem; }
    .revision-expand:hover:not(:disabled) { color: var(--text); }
    .revision-expand:focus-visible { outline-offset: -2px; }
    .revision-menu {
      visibility: hidden; position: fixed; inset: auto; margin: 0; padding: .45rem; overflow: auto; overscroll-behavior: contain;
      /* A scrollbar appearing must not narrow columns sized to their names. */
      scrollbar-gutter: stable;
      border: 1px solid var(--border); border-radius: var(--ui-radius, 8px); background: var(--surface-active); color: var(--text);
      box-shadow: 0 .65rem 1.8rem rgb(0 0 0 / .45);
    }
    .revision-menu[data-positioned] { visibility: visible; }
    .revision-options { display: flex; flex-direction: column; gap: .15rem; }
    .revision-section { display: grid; grid-template-columns: repeat(var(--revision-columns, 1), minmax(0, 1fr)); gap: .15rem .5rem; }
    .revision-section + .revision-section { padding-top: .15rem; border-top: 1px solid var(--border); }
    .revision-options button {
      min-width: 0; padding: .375rem .6rem; border: 0; border-radius: var(--ui-radius, 4px); background: transparent; color: var(--text);
      text-align: left; font-size: .76rem;
    }
    .revision-options button span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .revision-options button[aria-selected=true] { color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
    .revision-options button:hover, .revision-options button[data-active] { background: color-mix(in srgb, var(--text) 8%, transparent); }
    .revision-options button[data-active] { outline: 1px solid var(--accent); outline-offset: -1px; }
    /* A collapsible prefix heads its own row, its branches in a section below. */
    .revision-options .revision-group { display: flex; align-items: center; gap: .4rem; }
    .revision-group svg { flex: none; width: .75rem; height: .75rem; color: var(--muted); }
    .revision-group[aria-expanded=false] svg { rotate: -90deg; }
    .revision-options .revision-group .count {
      display: inline-flex; flex: none; min-width: 1.1rem; padding: 0 .35rem; background: transparent; font-size: .7rem;
    }
    .revision-empty { margin: 0; padding: .65rem; color: var(--muted); font-size: .75rem; cursor: default; user-select: none; }
    button:disabled, input:disabled { opacity: .5; }
  `

  constructor() {
    super()
    this.refs = null
    this.kind = 'branch'
    this.name = ''
    this.disabled = false
    this._open = false
    this._query = ''
    this._active = -1
    this._expanded = new Set()
    // Whether focus came by the keyboard, for the ring; a pointer pressing
    // in it clears the ring, and says the next focus didn't come by the
    // keyboard either, until a key is pressed.
    this._keyboard = false
    this._pointer = false
    this._onViewport = () => this.position()
    this._onKey = () => { this._pointer = false }
  }

  connectedCallback() {
    super.connectedCallback()
    globalThis.addEventListener('resize', this._onViewport)
    globalThis.addEventListener('scroll', this._onViewport, true)
    globalThis.addEventListener('keydown', this._onKey, true)
  }

  disconnectedCallback() {
    globalThis.removeEventListener('resize', this._onViewport)
    globalThis.removeEventListener('scroll', this._onViewport, true)
    globalThis.removeEventListener('keydown', this._onKey, true)
    super.disconnectedCallback()
  }

  updated(changed) {
    if (changed.has('installTooltips')) this.installTooltips?.(this.renderRoot)
    this.position()
  }

  change(how, kind, name) {
    this.dispatchEvent(new CustomEvent('revision-change', { detail: { how, kind, name }, bubbles: true, composed: true }))
  }

  suggestions(kind = this.kind) {
    const refs = this.refs ?? { branches: [], tags: [] }
    const choices = kind === 'branch' ? refs.branches : kind === 'tag' ? refs.tags : []
    const ordered = kind === 'branch'
      ? [...refs.defaultBranch ? [refs.defaultBranch] : [], ...orderBranches(choices.filter(name => name !== refs.defaultBranch))] : choices
    const query = this._query.trim().toLowerCase()
    return ordered.filter(name => name.toLowerCase().includes(query))
  }

  // The menu's rows: branches group by prefix until a query filters them.
  entries(expanded = this._expanded) {
    const names = this.suggestions()
    return this.kind === 'branch' && !this._query.trim()
      ? groupBranches(names, expanded, this.refs?.defaultBranch) : names.map(name => ({ name }))
  }

  toggleGroup(prefix) {
    const expanded = new Set(this._expanded)
    if (!expanded.delete(prefix)) expanded.add(prefix)
    this._expanded = expanded
  }

  // Runs of like branches (release lines, other versions, the rest, each open
  // group) lay out as separate grids, each sized to its own names. The default
  // branch joins the run after it.
  sections(entries) {
    const kind = entry => entry.group ?? (this.kind === 'branch' ? branchKind(entry.name) : 'all')
    const next = entries[1]?.prefix == null ? entries[1] : undefined
    const sections = []
    for (const [index, entry] of entries.entries()) {
      if (entry.prefix != null) { sections.push({ header: entry, index }); continue }
      const key = kind(index === 0 && entry.name === this.refs?.defaultBranch && next ? next : entry)
      if (sections.at(-1)?.key === key) sections.at(-1).items.push({ entry, index })
      else sections.push({ key, items: [{ entry, index }] })
    }
    return sections
  }

  // Opens the suggestions of `kind`, all of them or those `query` matches.
  show({ query = '', kind = this.kind } = {}) {
    if (kind === 'commit' || this.disabled) return
    // Each opening starts collapsed, but for the chosen branch's group.
    if (!this._open) this._expanded = new Set(this.name.includes('/') ? [this.name.slice(0, this.name.indexOf('/'))] : [])
    this._query = query
    this._active = -1
    this.renderRoot?.querySelector('.revision-menu')?.showPopover()
  }

  close() {
    this.renderRoot?.querySelector('.revision-menu')?.hidePopover()
    this._open = false
    this._active = -1
  }

  focusName() {
    this.renderRoot?.querySelector('.revision-name')?.focus({ preventScroll: true })
  }

  pick(name) {
    this.change('pick', this.kind, name)
    this.focusName()
    this.close()
  }

  pickKind(kind) {
    if (kind !== this.kind) {
      this.close()
      this.change('kind', kind, kind === 'branch' ? this.refs?.defaultBranch || '' : '')
    }
    this.focusName()
    this.show({ kind })
  }

  position() {
    if (!this._open) return
    const menu = this.renderRoot.querySelector('.revision-menu')
    const options = menu.querySelector('.revision-options')
    const rect = this.renderRoot.querySelector('.revision-name').getBoundingClientRect()
    const margin = 8
    const gap = 6
    const fontSize = parseFloat(getComputedStyle(this).fontSize)
    // Size each section's columns to its longest name and the option's padding,
    // so compact names such as version tags fit more per row. Longer names
    // still ellipsize past 15em.
    const range = document.createRange()
    const option = options.querySelector('.revision-section > button')
    const padding = option ? parseFloat(getComputedStyle(option).paddingLeft) + parseFloat(getComputedStyle(option).paddingRight) : 0
    const sections = [...options.querySelectorAll('.revision-section')].map(section => {
      let labelWidth = 0
      for (const label of section.querySelectorAll('button > span')) {
        range.selectNodeContents(label)
        labelWidth = Math.max(labelWidth, range.getBoundingClientRect().width)
      }
      return { section, count: section.children.length, columnWidth: Math.max(5 * fontSize, Math.min(15 * fontSize, Math.ceil(labelWidth + padding) + 1)) }
    })
    const spacing = sections.length > 0 ? parseFloat(getComputedStyle(sections[0].section).columnGap) || 0 : 0
    const chrome = menu.offsetWidth - options.clientWidth
    // Fill the field's width, widening past a narrow field to up to three
    // columns once a section has more than eight suggestions per column.
    const width = Math.min(window.innerWidth - 2 * margin, Math.max(rect.width,
      ...sections.map(({ count, columnWidth }) => Math.min(3, Math.ceil(count / 8)) * (columnWidth + spacing) - spacing + chrome)))
    // Short lists stay one column, counting branches in collapsed groups so
    // opening one never reflows the rest. Longer sections spread evenly over
    // the rows they need.
    const short = this.entries({ has: () => true }).length <= 8
    for (const { section, count, columnWidth } of sections) {
      const fit = Math.max(1, Math.floor((width - chrome + spacing) / (columnWidth + spacing)))
      section.style.setProperty('--revision-columns', short ? 1 : Math.ceil(count / Math.ceil(count / fit)))
    }
    menu.style.width = `${width}px`
    menu.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`
    const below = window.innerHeight - rect.bottom - gap - margin
    const above = rect.top - gap - margin
    // Open upward only when 320px doesn't fit below, then grow up to 420px where
    // the screen has room.
    const upward = below < Math.min(menu.scrollHeight, 320) && above > below
    menu.style.maxHeight = `${Math.max(0, Math.min(420, upward ? above : below))}px`
    menu.style.top = `${Math.max(margin, upward ? rect.top - menu.offsetHeight - gap : rect.bottom + gap)}px`
    menu.dataset.positioned = ''
  }

  async keyDown(event) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape' && this._open) { event.preventDefault(); event.stopPropagation() }
      this.close()
      return
    }
    if (event.key === 'Enter') {
      const entry = this.entries()[this._active]
      if (this._open && entry?.prefix != null) { event.preventDefault(); this.toggleGroup(entry.prefix) }
      else if (this._open && entry != null) { event.preventDefault(); this.pick(entry.name) }
      else this.close()
      return
    }
    if (this.kind === 'commit' || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    if (!this._open) this.show()
    const count = this.entries().length
    this._active = count === 0 ? -1 : event.key === 'ArrowDown'
      ? Math.min(this._active + 1, count - 1) : this._active <= 0 ? count - 1 : this._active - 1
    await this.updateComplete
    this.renderRoot.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }

  render() {
    const choices = this.entries()
    const label = this.kind === 'commit' ? 'Commit SHA' : this.kind === 'tag' ? 'Tag' : 'Branch'
    const listed = this.kind !== 'commit'
    return html`<form class=${this._keyboard ? 'revision keyboard' : 'revision'} @pointerdown=${() => { this._pointer = true; this._keyboard = false }}
      @focusin=${() => { this._keyboard = !this._pointer }}
      @focusout=${event => { if (!event.currentTarget.contains(event.relatedTarget)) { this._keyboard = false; this.close() } }}
      @submit=${event => { event.preventDefault(); this.change('submit', this.kind, this.name) }}>
      <div class="revision-switch" role="group" aria-label="Revision type">${REVISION_TYPES.map(({ kind, label: name, icon }) => html`<button type="button" aria-label=${name} data-tooltip=${name}
        aria-pressed=${this.kind === kind} ?disabled=${this.disabled} @click=${() => this.pickKind(kind)}>${icon}</button>`)}</div>
      <span class="revision-size" data-value=${this.name}><input class="revision-name" type="text" size="1" aria-label=${label} role=${ifDefined(listed ? 'combobox' : undefined)} aria-autocomplete=${ifDefined(listed ? 'list' : undefined)}
        aria-expanded=${ifDefined(listed ? String(this._open) : undefined)} aria-controls=${ifDefined(listed ? 'revisions' : undefined)}
        aria-activedescendant=${ifDefined(this._open && this._active >= 0 ? `revision-${this._active}` : undefined)} autocomplete="off" spellcheck="false"
        placeholder=${listed ? `Choose or enter a ${this.kind}…` : 'Commit SHA…'} .value=${live(this.name)} ?disabled=${this.disabled}
        @focus=${() => this.show()} @click=${() => this.show()} @keydown=${this.keyDown}
        @input=${event => { this.change('input', this.kind, event.target.value); this.show({ query: event.target.value }) }}></span>
      ${listed ? html`<button type="button" class="revision-expand" aria-label=${`Show ${this.kind} suggestions`} aria-expanded=${this._open} ?disabled=${this.disabled}
        @mousedown=${event => event.preventDefault()} @click=${() => { if (this._open) this.close(); else { this.focusName(); this.show() } }}>${chevronIcon}</button>` : nothing}
      <div class="revision-menu" id="revisions" popover="auto" role="listbox" aria-label=${`${label} suggestions`}
        @beforetoggle=${event => { this._open = event.newState === 'open'; delete event.target.dataset.positioned; if (!this._open) this._active = -1 }}>
        <div class="revision-options">${this.sections(choices).map(({ header, index: headerIndex, items }) => header
          ? html`<button type="button" role="option" class="revision-group" id=${`revision-${headerIndex}`} aria-selected="false" aria-expanded=${header.expanded} ?data-active=${headerIndex === this._active} tabindex="-1" @mousedown=${event => event.preventDefault()} @click=${() => { this._active = -1; this.toggleGroup(header.prefix) }}>${chevronIcon}<span>${header.prefix}/</span><span class="count" aria-label=${`${header.count} branches`}>${header.count}</span></button>`
          : html`<div class="revision-section" role="none">${items.map(({ entry, index }) => html`<button type="button" role="option" id=${`revision-${index}`} aria-label=${ifDefined(entry.label === undefined ? undefined : entry.name)} aria-selected=${entry.name === this.name} ?data-active=${index === this._active} tabindex="-1" @mousedown=${event => event.preventDefault()} @click=${() => this.pick(entry.name)}><span data-tooltip-truncated data-tooltip=${entry.name}>${entry.label ?? entry.name}</span></button>`)}</div>`)}</div>
        ${choices.length > 0 ? nothing : html`<p class="revision-empty">${this._query ? 'No matching suggestions. Enter a revision name to browse.' : `No ${this.kind} suggestions available.`}</p>`}
      </div>
    </form>`
  }
}

// Both entry points can load this component in the same document.
if (!customElements.get('revision-select')) customElements.define('revision-select', RevisionSelect)
