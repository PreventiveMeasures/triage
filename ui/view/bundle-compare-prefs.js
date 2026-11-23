// View preferences shared by every comparison, Compare's and Review's, in
// its Code view (bundle-compare-code.js) and Diff view (bundle-compare-all.js),
// reset on page reload like the rail's width.
export const prefs = { layout: 'unified', ignoreWhitespace: false, ignoreRenames: false, ignoreTypes: false }

// How a review's diff is drawn, as its route names it (common/managed/routes.js):
// whitespace changes hidden, type-only changes hidden, and pretty-printing,
// `state.bundleSourcePretty` (pretty-source.js); each only where it is on.
export const reviewView = state => ({ ...prefs.ignoreWhitespace ? { hideWhitespace: true } : {}, ...prefs.ignoreTypes ? { hideTypes: true } : {},
  ...state.bundleSourcePretty ? { pretty: state.bundleSourcePretty } : {} })
