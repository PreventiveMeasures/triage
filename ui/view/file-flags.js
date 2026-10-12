// What a listed file is flagged with, as its tags in the list show it (the
// npm Overview's Files, Compare's file groups): `{ name, severity }` each,
// its tag's text and how severe it is, and the Flags order those lists
// offer where any file in them has one.

// How severe a flag is, the most first: an alert's severity, a warning's
// (`high`, as its tag's color is), and a notice, under a low alert, as risk
// ranks its stamps (risk/files/stamps.js).
import { SEVERITIES as FLAG_SEVERITIES } from '../../risk/files/stamps.js'

export { FLAG_SEVERITIES }
const rank = ({ severity }) => FLAG_SEVERITIES.indexOf(severity)
const byNames = (a, b) => a.reduce((found, flag, i) => found || flag.name.localeCompare(b[i].name), 0)

// `rows` in Flags order, `flagsOf(row)` its flags and `pathOf(row)` its
// path: by their most severe flag, then the most flags, then their flags'
// names (each file's most severe first), then their paths; a file with
// none after every flagged one, by its path.
export function byFlags(rows, flagsOf, pathOf) {
  return rows.map(row => ({ row, path: pathOf(row), flags: flagsOf(row).toSorted((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)) }))
    .toSorted((a, b) => (b.flags.length > 0) - (a.flags.length > 0) || (a.flags.length > 0 && (rank(a.flags[0]) - rank(b.flags[0])
      || b.flags.length - a.flags.length || byNames(a.flags, b.flags))) || a.path.localeCompare(b.path))
    .map(({ row }) => row)
}
