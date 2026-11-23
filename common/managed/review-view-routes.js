// How a review's diff is drawn, as its URL names it past what it reviews
// (routes.js): changes hidden, `hide=whitespace,type-only` (`hideWhitespace`,
// `hideTypes`), and pretty-printing, `pretty=on`, or for JSON `folded`
// (`pretty`, as state.bundleSourcePretty has it: `indented` or `folded`).
// Each setting by its name in the URL and its route field.
const HIDES = [['whitespace', 'hideWhitespace'], ['type-only', 'hideTypes']]
const PRETTY = [['on', 'indented'], ['folded', 'folded']]

// A review route's query parameters for how its diff is drawn: none where all is off.
export function reviewViewQuery(route) {
  const hide = HIDES.filter(([, field]) => route[field] === true).map(([name]) => name)
  const pretty = PRETTY.find(([, value]) => value === route.pretty)?.[0]
  return [...hide.length > 0 ? [`hide=${hide.join(',')}`] : [], ...pretty ? [`pretty=${pretty}`] : []]
}

// The route fields a review URL's `search` names, each `hide` read. A
// setting it doesn't know is left out, not the link refused: it changes how
// the review is drawn, never what is reviewed.
export function reviewViewOf(search) {
  const hide = new Set(search.getAll('hide').flatMap(names => names.split(',')))
  const pretty = PRETTY.find(([name]) => name === search.get('pretty'))?.[1]
  return { ...Object.fromEntries(HIDES.filter(([name]) => hide.has(name)).map(([, field]) => [field, true])), ...pretty ? { pretty } : {} }
}
