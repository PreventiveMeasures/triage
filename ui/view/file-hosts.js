// The hosts a version's code names, and the services malicious packages send
// what they take to, fetch what they run from or look the machine up with, as
// risk tells them (risk/files/hosts.js): each version's files read once, and
// the services' tags, Exfiltration's, Remote's and IP lookup's.
import { html, nothing } from 'lit'
import { EXFILTRATION, npmHostSeverity, npmHostTags } from '../../risk/files/hosts.js'
import { fileRiskOf } from './file-risk.js'
import { linesNote, onlyLine, opensAt } from './file-runs-code.js'


// The services a version's file names, under the hosts' tags, as risk read it
// (file-risk.js fileRiskOf).
export const npmFileExfiltration = (details, path) => fileRiskOf(details, path).exfiltration

// The services any of `founds` names, by name, in their order: `webhook.site, Telegram`.
export const npmExfiltrationNames = founds => [...EXFILTRATION].filter(([service]) => founds.some(found => found.has(service))).map(([, { name }]) => name).join(', ')

// The services a file names, each with its lines: `Telegram (line 3)`; with
// `was`, those it didn't name saying so.
export const npmExfiltrationSaid = (found, was) => [...found].map(([service, lines]) =>
  `${EXFILTRATION.get(service).name} (${linesNote(lines)}${was !== undefined && !was?.has(service) ? ', new' : ''})`).join(', ')

// What each tag's tooltip says of the services under it.
const TAG_NOTES = new Map([
  ['Exfiltration', 'Names a host that catches what is sent to it, as malicious packages send what they take to'],
  ['Remote', 'Names a service malicious packages send what they take to, or fetch what they run from, though code may well use it'],
  ['IP lookup', 'Looks up the machine\'s public address, as malicious packages do before sending what they take'],
])

// A file's tags where it names any of the services, Exfiltration's, Remote's
// and IP lookup's, each at its severity's color (risk/files/hosts.js
// npmHostSeverity), naming them and their lines in its tooltip; with `was`,
// the services it named as the version compared with has it (null for none),
// one it didn't saying so and its tag a level higher; with `path`, for a list
// whose rows open the file, one on one line opening it there.
export function npmExfiltrationTag(found, was, path) {
  if (!found) return nothing
  return npmHostTags(found).map(([tag, services]) => {
    const at = opensAt(path, path === undefined ? undefined : onlyLine([...services.values()]))
    return html`<span data-bundle-view-source=${at.path} data-bundle-view-line=${at.line}
      class=${`npm-exfiltration is-${npmHostSeverity(tag, services, was)}`} data-tooltip=${`${TAG_NOTES.get(tag)}: ${npmExfiltrationSaid(services, was)}`}>${tag}</span>`
  })
}
