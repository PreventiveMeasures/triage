import { html, nothing } from 'lit'
import { bundleSourcemapEdges } from '../../common/bundle-sourcemap.js'
import { bundleSourcesAsMap } from './bundle-sources.js'

// The Code tab's Imported by button, beside the open file's Copy and GitHub
// buttons: the files that import it, as the bundle records its imports, in a
// menu, each opening on the line of its import. A Stasis bundle records them
// under every condition and platform; a sourcemap where its map gives them.
// An npm version, a repository or a bundle recording none has no button, as
// nothing says what imports its files.

// Importers shown; past them the menu says how many more.
const IMPORTERS_SHOWN = 100

// Each file's importers, `Map<target, Map<parent, Set<specifier>>>`, read
// once for its imports; null where it records none.
const indexes = new WeakMap()
function importersIndex(details) {
  const recorded = details?.kind === 'stasis' ? details.bundle?.imports
    : details?.kind === 'sourcemap' && (details.edges || details.map) ? bundleSourcemapEdges(details) : null
  if (!recorded || (recorded.size ?? recorded.length) === 0) return null
  if (indexes.has(recorded)) return indexes.get(recorded)
  const index = new Map()
  const add = (parent, specifier, target) => {
    if (typeof target !== 'string' || target === parent) return
    if (!index.has(target)) index.set(target, new Map())
    const parents = index.get(target)
    if (!parents.has(parent)) parents.set(parent, new Set())
    if (specifier !== undefined) parents.get(parent).add(specifier)
  }
  if (details.kind === 'stasis') {
    for (const byParent of recorded.values()) {
      for (const [parent, specifiers] of byParent) {
        for (const [specifier, resolved] of specifiers) {
          for (const target of typeof resolved === 'string' ? [resolved] : resolved instanceof Map ? resolved.values() : []) add(parent, specifier, target)
        }
      }
    }
  } else for (const [from, to, specifier] of recorded) add(from, specifier, to)
  indexes.set(recorded, index)
  return index
}

// The line a specifier is first written on in `content`, quoted; null where
// it is written nowhere so (built, or computed). Kept for the file's text.
const lines = new WeakMap()
function importLine(sources, parent, specifiers) {
  const content = sources.get(parent)
  if (typeof content !== 'string') return null
  if (!lines.has(sources)) lines.set(sources, new Map())
  const kept = lines.get(sources), key = JSON.stringify([parent, ...specifiers])
  if (!kept.has(key)) {
    let at = -1
    for (const specifier of specifiers) {
      for (const quote of ['\'', '"', '`']) {
        const found = content.indexOf(`${quote}${specifier}${quote}`)
        if (found !== -1 && (at === -1 || found < at)) at = found
      }
    }
    let line = null
    if (at !== -1) {
      line = 1
      for (let i = content.indexOf('\n'); i !== -1 && i < at; i = content.indexOf('\n', i + 1)) line++
    }
    kept.set(key, line)
  }
  return kept.get(key)
}

// The files importing `path`, by path, each with the specifiers it names it
// by, whether this bundle holds its source, and the line of its import there;
// null where the bundle records no imports.
export function bundleFileImporters(details, path) {
  const index = importersIndex(details)
  if (!index) return null
  const sources = bundleSourcesAsMap(details)
  return [...index.get(path) ?? []].toSorted(([a], [b]) => a.localeCompare(b)).map(([parent, specifiers]) => {
    const held = sources.has(parent)
    return { path: parent, specifiers: [...specifiers].toSorted(), held, line: held ? importLine(sources, parent, specifiers) : null }
  })
}

const IMPORTERS_ICON = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4.5V2h5.5L14 4.5V14H6v-2.5"/><path d="M1.5 8h8M7 5.5 9.5 8 7 10.5"/></svg>`

const files = count => `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'}`

// Under its button, left edges aligned, or above it where the viewport's
// bottom would cut it; within the viewport's sides.
function placeMenu(e) {
  if (e.newState !== 'open') return
  const menu = e.currentTarget
  const button = menu.getRootNode().querySelector?.(`[popovertarget="${menu.id}"]`)
  if (!button) return
  const at = button.getBoundingClientRect()
  // Unmeasured while closed: typical dimensions until it opens.
  const gap = 4, height = menu.offsetHeight || 200, width = menu.offsetWidth || 320
  const left = Math.max(4, Math.min(at.left, window.innerWidth - width - 4))
  const below = at.bottom + gap
  menu.style.left = `${left}px`
  menu.style.top = `${below + height > window.innerHeight - 4 && at.top > height + gap ? at.top - height - gap : below}px`
}

// The button and its menu for the open file; nothing where the bundle records
// no imports. A file it holds opens from the menu on its import's line
// (`data-bundle-view-source`, events.js); one it doesn't, an importer it
// records alone, is listed without opening.
export function renderBundleCodeImporters(details, path) {
  const importers = bundleFileImporters(details, path)
  if (!importers) return nothing
  const entry = details.kind === 'stasis' && details.bundle.entries?.has(path)
  const label = importers.length === 0 ? `Imported by no file${entry ? ' · an entry point' : ''}` : `Imported by ${files(importers.length)}`
  return html`<button type="button" class="bundle-code-importers-toggle" popovertarget="bundle-code-importers" popovertargetaction="toggle"
      aria-label=${label} data-tooltip=${label}>${IMPORTERS_ICON}<span class="bundle-code-importers-count">${importers.length.toLocaleString()}</span></button>
    <div popover="auto" id="bundle-code-importers" class="bundle-code-importers" role="menu" aria-label="Imported by" @beforetoggle=${placeMenu}
      @click=${e => { if (e.target.closest('[data-bundle-view-source]')) e.currentTarget.hidePopover() }}>
      <div class="bundle-code-importers-head">${importers.length === 0 ? label : `Imported by ${files(importers.length)}`}</div>
      ${importers.slice(0, IMPORTERS_SHOWN).map(importer => {
        const row = html`<span class="bundle-code-importers-path mono">${importer.path}</span>${importer.specifiers.length > 0
          ? html`<span class="bundle-code-importers-specifier mono">${importer.specifiers.join(', ')}</span>` : nothing}`
        return importer.held
          ? html`<button type="button" class="bundle-code-importers-item" role="menuitem" data-tooltip-truncated data-tooltip=${importer.path}
              data-bundle-view-source=${importer.path} data-bundle-view-line=${importer.line ?? nothing}>${row}</button>`
          : html`<span class="bundle-code-importers-item is-absent" role="menuitem" aria-disabled="true"
              data-tooltip=${`${importer.path} · not in this bundle`}>${row}</span>`
      })}
      ${importers.length > IMPORTERS_SHOWN ? html`<div class="bundle-code-importers-more">and ${files(importers.length - IMPORTERS_SHOWN)} more</div>` : nothing}
    </div>`
}
