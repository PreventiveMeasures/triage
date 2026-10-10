// How a treemap of a single package colors its files (bundle-treemap.js),
// where coloring by package would paint them all one color: by the top-most
// directories that tell them apart. Below the directories every file shares,
// each directory is a group. Directories every file but those loose beside
// them shares are passed through on the way, and the files loose in one are a
// group of their own, `dir/*`, or `dir/*.js` where they share an extension.
// `src/a/a.js`, `src/b/b.js` and `src/c.js` make `src/a/`, `src/b/` and
// `src/*.js`; `package.json`, `README.md` and `dist/{a,b}/…` make `*`,
// `dist/a/` and `dist/b/`. Where that leaves one group, as for a package of
// loose files alone, each extension is one.

const extensionOf = (name) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

// Each of `paths` (relative to `prefix`, which the labels name) by its
// group's label.
export function treemapGroups(paths, prefix = '') {
  const split = paths.map((path) => path.split('/'))
  // The directories passed through: at each level, the only directory there.
  const spine = []
  for (;;) {
    const depth = spine.length
    const dirs = new Set()
    for (const parts of split) {
      if (parts.length > depth + 1 && spine.every((segment, i) => parts[i] === segment)) dirs.add(parts[depth])
    }
    if (dirs.size !== 1) break
    spine.push(dirs.values().next().value)
  }
  const keys = split.map((parts) => {
    let depth = 0
    while (depth < spine.length && parts.length > depth + 1) depth++
    const base = prefix + parts.slice(0, depth).map((segment) => `${segment}/`).join('')
    return parts.length > depth + 1 ? `${base}${parts[depth]}/` : `${base}*`
  })
  if (new Set(keys).size > 1) {
    // Loose files sharing one extension name it.
    const extensions = new Map()
    keys.forEach((key, i) => {
      if (!key.endsWith('*')) return
      const found = extensions.get(key) ?? new Set()
      found.add(extensionOf(split[i].at(-1)))
      extensions.set(key, found)
    })
    const label = (key) => {
      const found = extensions.get(key)
      return found?.size === 1 && !found.has('') ? `${key}${[...found][0]}` : key
    }
    return new Map(paths.map((path, i) => [path, label(keys[i])]))
  }
  return new Map(paths.map((path, i) => {
    const extension = extensionOf(split[i].at(-1))
    return [path, extension ? `*${extension}` : 'No extension']
  }))
}
