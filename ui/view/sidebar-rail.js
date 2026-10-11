// Two letters for a team or workspace in the collapsed sidebar: the initials
// of its first two words, capitalized unless the name starts in lowercase, or
// the first two letters of a one-word name as written ("Security fixtures" →
// "SF", "platform review" → "pr", "Frontend" → "Fr").
export function railLetters(name) {
  const words = String(name ?? '').split(/[\s\-_/.]+/u).filter(Boolean)
  if (words.length < 2) return Array.from(words[0] ?? '').slice(0, 2).join('')
  const initials = words.slice(0, 2).map(word => Array.from(word)[0]).join('')
  return /^\p{Ll}/u.test(initials) ? initials : initials.toUpperCase()
}
