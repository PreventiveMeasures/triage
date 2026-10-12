// The hosts a version's code names, and the services malicious packages send
// what they take to, as risk tells them (risk/files/hosts.js): each version's
// files read once, and an exfiltration host's tag.
import { html, nothing } from 'lit'
import { EXFILTRATION } from '../../risk/files/hosts.js'
import { npmVersionFileRisk } from '../../risk/npm/files.js'
import { linesNote, onlyLine, opensAt } from './file-runs-code.js'

export { EXFILTRATION, npmExfiltration, npmHosts } from '../../risk/files/hosts.js'

// The hosts a version's file names and the exfiltration services it names, as
// risk read it, once a version (risk/npm/compare.js npmVersionFileRisk).
export const npmFileHosts = (details, path) => npmVersionFileRisk(details, path).hosts
export const npmFileExfiltration = (details, path) => npmVersionFileRisk(details, path).exfiltration

// The services any of `founds` names, by name, in their order: `webhook.site, Telegram`.
export const npmExfiltrationNames = founds => [...EXFILTRATION].filter(([service]) => founds.some(found => found.has(service))).map(([, { name }]) => name).join(', ')

// The services a file names, each with its lines: `Telegram (line 3)`; with
// `was`, those it didn't name saying so.
export const npmExfiltrationSaid = (found, was) => [...found].map(([service, lines]) =>
  `${EXFILTRATION.get(service).name} (${linesNote(lines)}${was !== undefined && !was?.has(service) ? ', new' : ''})`).join(', ')

// A file's Exfiltration tag where it names any of the services, in orange as
// what it runs is (file-runs-code.js), naming them and their lines in its
// tooltip; with `was`, the services it named as the version compared with has
// it (null for none), one it didn't saying so; with `path`, for a list whose
// rows open the file, one on one line opening it there.
export function npmExfiltrationTag(found, was, path) {
  if (!found) return nothing
  const at = opensAt(path, path === undefined ? undefined : onlyLine([...found.values()]))
  return html`<span data-bundle-view-source=${at.path} data-bundle-view-line=${at.line}
    class="npm-exfiltration" data-tooltip=${`Names a host malicious packages send what they take to: ${npmExfiltrationSaid(found, was)}`}>Exfiltration</span>`
}
