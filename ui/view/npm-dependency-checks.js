// What calls for a look among the dependencies a package version names, as
// risk tells it (risk/npm/dependencies.js): the Overview's Dependencies
// column (npm-package.js), Compare's chips (npm-overview.js) and the
// dependencies over its package.json (bundle-compare-code.js) flag them.
import { html } from 'lit'

export { npmDependencies, npmDependencyChanges } from '../../risk/npm/dependencies.js'
export { npmAlias } from '../../risk/npm/specs.js'

// A dependency's flags, as tags in its warning's color, each saying why in
// its tooltip: in the Overview's Dependencies column (npm-package.js), and
// in Compare's and over its package.json (bundle-compare.js,
// bundle-compare-code.js).
export const npmDependencyFlagTags = (flags = []) => flags.map(({ check, label, tooltip }) => html`<span class=${`npm-dependency-flag is-${check}`} data-tooltip=${tooltip}>${label}</span>`)
