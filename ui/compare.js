// A bundle's Compare tab (`<bundle-compare>`), an npm package's Review tab
// (`<npm-review>`) and My reviews (`<dependency-review-list>`). An esbuild
// entry that view/compare-load.js imports by a runtime string on first use, so
// view.js doesn't carry them; built with view.js, it shares its lit and client
// state.
import './view/bundle-compare.js'
import './view/npm-review.js'
import './view/dependency-review-list.js'
