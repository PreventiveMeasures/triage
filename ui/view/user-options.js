// Each user as a choice, by the name they chose and their login under it.
// Its value is `user.id`, and its avatar the user `user.userId` names where it
// is given (null for one with none, as a legacy login has), else `user.id`.
export function userOptions(users) {
  return users.map(user => {
    const login = user.login || String(user.id)
    const name = user.name?.trim() || `@${login}`
    const secondary = name === `@${login}` ? '' : `@${login}`
    const initials = name.replace(/^@/u, '').split(/\s+/u).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase()
    const avatar = user.userId === undefined ? user.id : user.userId
    return { value: user.id, avatar, label: secondary ? `${name} ${secondary}` : name, displayLabel: name, secondary, initials, disabled: user.disabled, detail: user.detail }
  })
}

export function userChoices(options, query) {
  const words = query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean)
  const users = options.filter(option => !option.reset)
  const visible = users.filter(option => words.every(word => option.label.normalize('NFKC').toLocaleLowerCase().includes(word)))
    .toSorted((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }))
  return { pinned: options.filter(option => option.reset), sections: [{ label: null, options: visible }], facets: [], showFacets: false, count: visible.length, total: users.length }
}
