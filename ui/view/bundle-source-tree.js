// Display paths may omit a common prefix; leaf values always retain the
// original bundle key used to open the source and look up findings.
export function buildBundleSourceTree(paths, originals = paths) {
  const root = { files: new Map(), dirs: new Map() }
  for (let index = 0; index < paths.length; index++) {
    const parts = paths[index].split('/')
    let node = root
    for (const name of parts.slice(0, -1)) {
      if (!node.dirs.has(name)) node.dirs.set(name, { files: new Map(), dirs: new Map() })
      node = node.dirs.get(name)
    }
    node.files.set(parts.at(-1), originals[index])
  }
  return root
}

// Only fold unbranched, file-free directories. A conservative character
// budget leaves space for indentation and issue chips in the 320px rail;
// the three-segment limit keeps even very short paths easy to scan.
export function compactSourceDirectory(name, node, depth) {
  const names = [name]
  const limit = Math.max(12, 24 - Math.max(0, depth - 1) * 2)
  while (node.files.size === 0 && node.dirs.size === 1 && names.length < 3) {
    const [nextName, nextNode] = node.dirs.entries().next().value
    if ([...names, nextName].join('/').length > limit) break
    names.push(nextName)
    node = nextNode
  }
  return { names, node }
}

// Native summary/button semantics keep Enter, Space, and Tab working.
// Arrow keys navigate only visible rows; opening a file remains explicit.
export function navigateBundleSourceTree(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const tree = event.currentTarget
  const row = event.target.closest('summary, .bundle-code-tree-link')
  if (!row || !tree.contains(row)) return
  const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']
  if (!keys.includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  const rows = [...tree.querySelectorAll('summary, .bundle-code-tree-link')].filter(item => {
    let parent = item.parentElement
    if (item.tagName === 'SUMMARY') parent = parent.parentElement
    return !parent.closest('details:not([open])')
  })
  const index = rows.indexOf(row)
  const directory = row.tagName === 'SUMMARY' ? row.parentElement : null
  let next = row
  if (event.key === 'ArrowDown') next = rows[Math.min(index + 1, rows.length - 1)]
  if (event.key === 'ArrowUp') next = rows[Math.max(index - 1, 0)]
  if (event.key === 'Home') next = rows[0]
  if (event.key === 'End') next = rows.at(-1)
  if (event.key === 'ArrowRight' && directory) {
    if (directory.open) next = rows[index + 1] ?? row
    else row.click()
  }
  if (event.key === 'ArrowLeft') {
    if (directory?.open) row.click()
    else next = (directory ?? row).parentElement.closest('details')?.querySelector('summary') ?? row
  }
  next?.focus()
}
