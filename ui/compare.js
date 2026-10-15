// Compare: a bundle's Compare tab (`<bundle-compare>`, its Overview and Code
// diff), an npm package's Review tab (`<npm-review>`) and My reviews
// (`<dependency-review-list>`), which reviews by the same comparison. An
// esbuild entry point of its own: `view/compare-load.js` imports it by a
// runtime string the first time one of them opens, so view.js doesn't carry
// it. Built with view.js, it takes lit and the client state from the same
// chunks, and so the same instances.
import './view/bundle-compare.js'
import './view/npm-review.js'
import './view/dependency-review-list.js'
