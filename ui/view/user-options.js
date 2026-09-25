export function userOptions(users) {
  return users.map(user => {
    const login = user.login || String(user.id)
    const name = user.name?.trim() || `@${login}`
    const secondary = name === `@${login}` ? '' : `@${login}`
    const initials = name.replace(/^@/u, '').split(/\s+/u).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase()
    return { value: user.id, label: secondary ? `${name} ${secondary}` : name, displayLabel: name, secondary, initials, disabled: user.disabled, detail: user.detail }
  })
}

export function userChoices(options, query) {
  const words = query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean)
  const users = options.filter(option => !option.reset)
  const visible = users.filter(option => words.every(word => option.label.normalize('NFKC').toLocaleLowerCase().includes(word)))
    .toSorted((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }))
  return { pinned: options.filter(option => option.reset), sections: [{ label: null, options: visible }], facets: [], showFacets: false, count: visible.length, total: users.length }
}
