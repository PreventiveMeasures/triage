import { html, svg } from 'lit'

// Source-file icons shared by the repository picker and bundle Code view.
export function sourceFileType(path) {
  const name = String(path).split('/').at(-1)
  const extension = name.includes('.') ? name.split('.').at(-1).toLowerCase() : ''
  if (['js', 'jsx', 'mjs', 'cjs'].includes(extension)) return 'js'
  if (['ts', 'tsx', 'mts', 'cts'].includes(extension)) return 'ts'
  if (extension === 'sol') return 'solidity'
  if (extension === 'rs') return 'rust'
  return 'generic'
}

export function sourceFileIcon(path) {
  const type = sourceFileType(path)
  const mark = type === 'js' || type === 'ts'
    ? svg`<rect x="1" y="1" width="14" height="14" rx="2" fill=${type === 'js' ? '#e6c84f' : '#3178c6'}/><text x="8" y="11.5" text-anchor="middle" fill=${type === 'js' ? '#202020' : '#fff'} font-family="sans-serif" font-size="8" font-weight="700">${type.toUpperCase()}</text>`
    : type === 'solidity'
      ? svg`<path d="m8 1 4 6-4 2-4-2Z" fill="currentColor"/><path d="m4 8 4 2 4-2-4 7Z" fill="currentColor" opacity=".65"/>`
      : type === 'rust'
        ? svg`<path d="m7 0 2 0 .4 1.6 1.3.5 1.4-.9 1.4 1.4-.9 1.4.5 1.3 1.6.4v2l-1.6.4-.5 1.3.9 1.4-1.4 1.4-1.4-.9-1.3.5-.4 1.6H7l-.4-1.6-1.3-.5-1.4.9-1.4-1.4.9-1.4-.5-1.3L1.3 9V7l1.6-.4.5-1.3-.9-1.4 1.4-1.4 1.4.9 1.3-.5Z" fill="#c97d5d"/><circle cx="8" cy="8" r="4.4" fill="var(--surface, #fff)"/><text x="8" y="10.8" text-anchor="middle" fill="currentColor" font-family="serif" font-size="8" font-weight="700">R</text>`
        : svg`<path d="M4 1.5h5l3 3v10H4Zm5 0v3h3M6 8h4M6 10.5h4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>`
  return html`<svg class="source-file-icon" data-file-type=${type} width="16" height="16" viewBox="0 0 16 16" style="flex: none" aria-hidden="true">${mark}</svg>`
}

export const sourceFolderIcon = html`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" style="flex: none" aria-hidden="true"><path d="M1.5 4V2.5h5L8 4h6.5v9h-13Z" stroke-linejoin="round"/></svg>`

export const sourceNpmIcon = html`<svg class="bundle-code-tree-npm" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M1 1h14v14H1Zm3 3v8h4V6h2v6h2V4Z"/></svg>`
