// What a `run:` script fetches and runs past a pin (commands.js), graded as
// findings, each `{ id, severity, line, … }`, `line` the file's:
//
// - `fetched-package`: a package fetched as it resolves now. npx, `npm
//   exec`, bunx and `bun x` run the project's own where it is installed: one
//   a lockfile at or above the directory the step runs in locks, once an
//   install ran before it in its job, is none; else, as any other fetching
//   tool's, orange, but yellow where a version names it, as its integrity
//   is still whatever the registry has, or a variable does, and a notice for
//   pip, setuptools and wheel themselves. A Go module by its version is none: Go's checksum
//   database holds it to what it was; a crate by its version built with its
//   own lockfile (`--locked`) none too.
// - `unlocked-install`: an install that resolves anew where package.json and
//   the lockfile disagree, as `npm install` does, yellow; low for Yarn's and
//   Bun's, which Yarn 2 and later refuse to in CI on their own.
// - `remote-script`: a script fetched and run as it is fetched, orange.
// - `unpinned-image`: an image run by a tag, which its publisher can move,
//   yellow, orange with none or `latest`; none with a digest.
// - `clone`: a repository cloned at whatever its branch has, low.
// - `hosts`: services a script names that malicious code sends what it
//   takes to or fetches what it runs from, by risk's tags (risk/files/hosts.js):
//   Exfiltration red, Remote orange, IP lookup yellow.
// - `script-injection`: an expression anyone can write (expressions.js) in
//   the script, orange, red where the workflow runs with its secrets for
//   anyone (PRIVILEGED_TRIGGERS).
import { HOST_TAGS, npmExfiltration, npmHostsTagged } from '../../risk/files/hosts.js'
import { PRIVILEGED_TRIGGERS, untrustedExpressions } from '../expressions.js'
import { installLine, scriptFinds } from './commands.js'

// Programs whose package is named otherwise, as npx finds a package by the
// program it runs: `npx tsc` runs typescript's where it is installed, and
// fetches the package named `tsc` where it isn't.
export const KNOWN_BINS = new Map([['tsc', 'typescript'], ['tsserver', 'typescript'], ['ng', '@angular/cli'], ['nest', '@nestjs/cli'],
  ['changeset', '@changesets/cli'], ['biome', '@biomejs/biome'], ['svelte-kit', '@sveltejs/kit'], ['api-extractor', '@microsoft/api-extractor'],
  ['commitlint', '@commitlint/cli'], ['attw', '@arethetypeswrong/cli'], ['ncu', 'npm-check-updates'], ['vue-cli-service', '@vue/cli-service'],
  ['firebase', 'firebase-tools'], ['netlify', 'netlify-cli'], ['cdk', 'aws-cdk'], ['sls', 'serverless'], ['playwright', '@playwright/test'],
  ['eas', 'eas-cli'], ['expo', 'expo'], ['vsce', '@vscode/vsce'], ['wdio', '@wdio/cli'], ['lhci', '@lhci/cli'], ['tsx', 'tsx'], ['webpack', 'webpack-cli']])
const PACKAGING = new Set(['pip', 'setuptools', 'wheel'])

// Whether `name`, as npx names a program or a package, is one of `locked`'s
// packages (a Set of names): by its own name, or the package known to
// provide it.
export const lockedName = (locked, name) => locked.has(name) || (KNOWN_BINS.has(name) && locked.has(KNOWN_BINS.get(name)))

// How severe fetching a package is, as told above; null for none.
function packageSeverity(found, { locked, installed, external }) {
  const runsOwn = found.ecosystem === 'npm' && found.localFirst && found.registry && (found.spec === null || found.exact)
  if (runsOwn && (external ? installed : locked && installed)) return null
  if (found.ecosystem === 'go' && found.exact) return null
  if (found.ecosystem === 'crates' && found.exact && found.locked) return null
  if (found.ecosystem === 'pypi' && PACKAGING.has(found.name.toLowerCase())) return 'notice'
  // A version a variable names may be one, set elsewhere in the workflow.
  return found.exact || found.spec?.includes('$') ? 'moderate' : 'high'
}

// What a package fetched is told by.
const packageOf = ({ tool, ecosystem, name, spec, exact, registry, localFirst }) => ({ tool, ecosystem, name, spec, exact, ...registry ? {} : { registry: false }, ...localFirst ? { localFirst } : {} })

// The findings of one find of a script; `locked(name)` whether a lockfile
// that applies locks it, `installed` whether an install ran before.
function graded(found, context) {
  if (found.kind === 'package') {
    const locked = found.ecosystem === 'npm' && found.localFirst ? context.locked(found.name) : false
    const severity = packageSeverity(found, { locked, installed: context.installed, external: context.external })
    return severity ? [{ id: 'fetched-package', severity, ...packageOf(found), ...found.localFirst ? { locked, installed: context.installed } : {} }] : []
  }
  if (found.kind === 'unlocked-install') return [{ id: 'unlocked-install', severity: /^(?:yarn|bun)\b/u.test(found.tool) ? 'low' : 'moderate', tool: found.tool }]
  if (found.kind === 'remote-script') return [{ id: 'remote-script', severity: 'high', command: found.command, ...found.saved ? { saved: found.saved } : {} }]
  if (found.kind === 'image') return found.read?.digest ? [] : [imageFinding(found.text, found.read, found.tool)]
  return found.kind === 'clone' ? [{ id: 'clone', severity: 'low', url: found.url }] : []
}

// An image run by a tag: orange with none or `latest`, else yellow.
export function imageFinding(text, read, via) {
  return { id: 'unpinned-image', severity: !read || read.tag === null || read.tag === 'latest' ? 'high' : 'moderate', image: text, via }
}

// The file's line a script's line is on: a `|` block scalar's own, in turn
// from where its text starts; any other's, the `run:` key's.
const fileLine = (run, line) => run.start === null ? run.line : run.start + line

// The line of a script's text at `index`, counting from 0.
const lineAt = (script, index) => script.slice(0, index).split('\n').length - 1

// Every finding of a step's `run` script (workflow.js runOf): what it
// fetches and runs, the services it names, and the expressions anyone can
// write in it. `context`: `locked(name)`, whether a lockfile that applies
// to where it runs locks a package of that name; `installed`, whether an
// install ran before it in its job, an earlier line of it counting too; `external`, whether it is another
// repository's action's, run in a workflow's workspace it can't tell;
// `triggers`, the workflow's events.
export function scriptFindings(run, context) {
  const findings = []
  // An install earlier in the script counts as one in a step before.
  const installed = installLine(run.script)
  for (const found of scriptFinds(run.script)) {
    const before = context.installed || (installed !== null && installed < found.line)
    for (const finding of graded(found, { ...context, installed: before })) findings.push({ ...finding, line: fileLine(run, found.line) })
  }
  const services = npmExfiltration('run.sh', run.script, true)
  for (const tag of HOST_TAGS.keys()) {
    const tagged = npmHostsTagged(services, tag)
    if (tagged) findings.push({ id: 'hosts', severity: HOST_TAGS.get(tag), tag, services: [...tagged.keys()], line: fileLine(run, Math.min(...[...tagged.values()].flat()) - 1) })
  }
  const privileged = context.triggers.some(event => PRIVILEGED_TRIGGERS.has(event))
  for (const { expression, index } of untrustedExpressions(run.script)) {
    findings.push({ id: 'script-injection', severity: privileged ? 'critical' : 'high', expression, line: fileLine(run, lineAt(run.script, index)) })
  }
  return findings
}
