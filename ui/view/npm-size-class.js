// How big an npm package is by each measure its Overview gives
// (render-bundle.js renderNpmPackageOverview): tiny, small, medium, large or
// gigantic, from the bounds below which it is each of the first four. Files,
// lines of code and bytes are of what it holds beyond the files every package
// has (npm-overview.js npmFilesRead), in steps of eight times that agree
// with each other for a file of about 130 lines and 5 KiB, about 40 bytes a
// line, as npm's packages run: a file or two is tiny, lodash's thousand-odd
// files, 40,000 lines and 1.3 MiB are large.
import { html } from 'lit'

const KIB = 1024, MIB = 1024 * KIB
export const NPM_SIZE_CLASSES = ['tiny', 'small', 'medium', 'large', 'gigantic']
const BOUNDS = {
  dependencies: [1, 4, 11, 26],
  // Text files.
  files: [3, 24, 192, 1536],
  lines: [400, 3200, 25_600, 204_800],
  // What its files unpack to, binary ones too.
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
