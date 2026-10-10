// How big an npm package is by each measure its Overview gives
// (render-bundle.js renderNpmPackageOverview): tiny, small, medium, large or
// gigantic, from the bounds below which it is each of the first four, in
// steps of about eight times, as packages run from a file to thousands.
import { html } from 'lit'

const KIB = 1024, MIB = 1024 * KIB
export const NPM_SIZE_CLASSES = ['tiny', 'small', 'medium', 'large', 'gigantic']
const BOUNDS = {
  dependencies: [1, 4, 11, 26],
  files: [5, 25, 150, 1000],
  lines: [250, 2500, 25_000, 250_000],
  // What its tarball unpacks to.
  unpacked: [16 * KIB, 128 * KIB, MIB, 8 * MIB],
}

export function npmSizeClass(measure, value) {
  const at = BOUNDS[measure].findIndex(bound => value < bound)
  return NPM_SIZE_CLASSES[at === -1 ? NPM_SIZE_CLASSES.length - 1 : at]
}

// A measure's value as shown (`text`), in its class's colour.
export function npmSized(measure, value, text) {
  return html`<span class=${`npm-sized is-${npmSizeClass(measure, value)}`}>${text}</span>`
}
