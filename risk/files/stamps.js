// A file's stamps: what risk reads of one file (the readers beside this), and
// what of it calls for a look, as a list of files tags it and orders it by:
// each `{ name, severity }`, its tag's text and how severe it is (SEVERITIES).
import { READABILITY, npmFileReadability, npmLabelMark, npmLargeCode, npmReadabilityLabels, npmTaggedCategory } from './readability.js'
import { npmExfiltration, npmHosts } from './hosts.js'
import { npmRunsCode, npmRunsCodeFlags } from './runs-code.js'

// How severe a stamp or a finding is, the most first: `critical` red,
// `high` a warning's orange, `moderate` yellow, `low`, and a `notice`, under
// a low one.
export const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'notice']

// A label's mark (readability.js READABILITY) as a severity.
const MARK_SEVERITIES = { warn: 'high', notice: 'notice' }

// What a file is flagged with in a list of files, as its tags there show it
// (npmFileFlagTags, npmListedReadabilityTag): `{ name, mark }` each, its
// tag's text and mark; none for what reads as most files do (UTF-8, ASCII).
function npmListedFlags(path, readability, bytes) {
  const category = readability && npmTaggedCategory(readability)
  const listed = category && category !== 'ascii' && category !== 'map' && READABILITY.get(category).mark
  return [
    ...npmLargeCode(path, bytes) ? [{ name: 'Large', mark: 'notice' }] : [],
    ...readability?.obfuscation ? [{ name: 'Obfuscated', mark: 'warn' }] : [],
    ...readability ? npmReadabilityLabels(readability).filter(label => label === 'controls' || label === 'long')
      .map(label => ({ name: READABILITY.get(label).tag, mark: npmLabelMark(readability, label) })) : [],
    ...listed ? [{ name: READABILITY.get(category).tag, mark: listed }] : [],
  ]
}

// A file's stamps, from what was read of it: what its code does beyond
// itself (runs-code.js npmRunsCodeFlags), a warning's or, for the whole
// environment read out and publishing, critical; an exfiltration host it
// names (hosts.js), a warning's; and its flags and how it reads
// (npmListedFlags), a warning's or a notice, by their marks.
const npmStampsOf = ({ path, bytes, readability, runsCode, exfiltration }) => [...npmRunsCodeFlags(runsCode),
  ...exfiltration ? [{ name: 'Exfiltration', severity: 'high' }] : [],
  ...npmListedFlags(path, readability, bytes).map(({ name, mark }) => ({ name, severity: MARK_SEVERITIES[mark] }))]

// Everything risk reads of a file (`path`, its `text`, null for one that
// isn't, and its size in `bytes`): how it reads (npmFileReadability), what
// its code does beyond itself (npmRunsCode), the exfiltration hosts it names
// (npmExfiltration) and the hosts its code names (npmHosts), and its
// `stamps` (npmStampsOf).
export function npmFileRisk(path, text, bytes) {
  const readability = npmFileReadability(path, text)
  const exfiltration = npmExfiltration(path, text), runsCode = npmRunsCode(path, text)
  return { readability, runsCode, exfiltration, hosts: npmHosts(path, text), stamps: npmStampsOf({ path, bytes, readability, runsCode, exfiltration }) }
}
