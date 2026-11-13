// `text` as a markdown code span, the way an issue body prints a path that
// links nowhere: GitHub reads nothing inside one, so the `@scope` of
// `node_modules/@scope/pkg` stays a path rather than a mention. The fence
// is one backtick longer than any run inside, and a space pads the text
// where its own backtick or space at an end would be taken for the fence's.
export function codeSpan(text) {
  if (!text) return text
  const fence = '`'.repeat(Math.max(0, ...[...text.matchAll(/`+/gu)].map(run => run[0].length)) + 1)
  const pad = /^`|`$/u.test(text) || (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}
