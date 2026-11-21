// What calls for a look among a version's dependencies, as risk tells it
// (risk/npm/dependencies.js), for the Overview, Compare and its package.json's diff.
import { html } from 'lit'

// A dependency's flags as tags in its warning's color, each saying why in its tooltip.
export const npmDependencyFlagTags = (flags = []) => flags.map(({ check, label, tooltip }) => html`<span class=${`npm-dependency-flag is-${check}`} data-tooltip=${tooltip}>${label}</span>`)
