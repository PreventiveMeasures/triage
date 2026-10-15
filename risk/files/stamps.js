// A file's stamps: what risk reads of one file (the readers beside this), and
// what of it calls for a look, as a list of files tags it and orders it by:
// each `{ name, severity }`, its tag's text and how severe it is (SEVERITIES).
import { READABILITY, npmFileReadability, npmLabelMark, npmLargeCode, npmReadabilityLabels, npmTaggedCategory } from './readability.js'
import { npmExfiltration, npmHostSeverity, npmHostTags, npmHosts } from './hosts.js'
import { npmRunsCode, npmRunsCodeFlags } from './runs-code.js'

// How severe a stamp or a finding is, the most first: `critical` red,
// `high` a warning's orange, `moderate` yellow, `low`, and a `notice`, under
// a low one.
export const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'notice']

// A label's mark (readability.js READABILITY) as a severity: a warning's
// orange, or a notice.
const severityOf = mark => mark === 'warn' ? 'high' : 'notice'

// A file's stamps, from what was read of it: what its code does beyond
// itself (runs-code.js npmRunsCodeFlags), a warning's or, for the whole
// environment read out and publishing, critical; the services it names
// (hosts.js), a stamp a tag, at the tag's severity (Exfiltration critical,
// Remote high, IP lookup moderate); a large code file, a notice; an
// obfuscator's fingerprint, a warning's; and its control characters, long
// lines and category, by their marks, but for what reads as most files do
// (UTF-8, ASCII) and a source map.
function npmStampsOf({ path, bytes, readability, runsCode, exfiltration }) {
  const category = npmTaggedCategory(readability)
  const listed = category !== 'ascii' && category !== 'map' && READABILITY.get(category).mark
  return [...npmRunsCodeFlags(runsCode),
    ...npmHostTags(exfiltration).map(([tag, services]) => ({ name: tag, severity: npmHostSeverity(tag, services) })),
    ...npmLargeCode(path, bytes) ? [{ name: 'Large', severity: 'notice' }] : [],
    ...readability.obfuscation ? [{ name: 'Obfuscated', severity: 'high' }] : [],
    ...npmReadabilityLabels(readability).filter(label => label === 'controls' || label === 'long')
      .map(label => ({ name: READABILITY.get(label).tag, severity: severityOf(npmLabelMark(readability, label)) })),
    ...listed ? [{ name: READABILITY.get(category).tag, severity: severityOf(listed) }] : []]
}

// Everything risk reads of a file (`path`, its `text`, null for one that
// isn't, and its size in `bytes`): how it reads (npmFileReadability), what
// its code does beyond itself (npmRunsCode), the services it names under the
// hosts' tags (npmExfiltration) and the hosts its code names (npmHosts), and its
// `stamps` (npmStampsOf); read as a script where node runs it as one whatever
// its name (`script`, npm/files.js npmLoadedScripts).
export function npmFileRisk(path, text, bytes, script = false) {
  const readability = npmFileReadability(path, text, script)
  const exfiltration = npmExfiltration(path, text, script), runsCode = npmRunsCode(path, text, script)
  return { readability, runsCode, exfiltration, hosts: npmHosts(path, text, script), stamps: npmStampsOf({ path, bytes, readability, runsCode, exfiltration }) }
}
