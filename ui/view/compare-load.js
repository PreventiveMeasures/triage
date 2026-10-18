// Compare's own bundle (ui/compare.js): a bundle's Compare tab
// (`<bundle-compare>`), an npm package's Review tab (`<npm-review>`) and My
// reviews (`<dependency-review-list>`), out of view.js until one of them opens.
import { lazyTemplate } from './lazy-template.js'

// `template()` once the bundle is here, a placeholder until then
// (lazy-template.js).
export const withCompare = lazyTemplate('./compare.js')
