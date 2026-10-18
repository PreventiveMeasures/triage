// What a `run:` script fetches and runs (commands.js), graded (README.md).
import { HOST_TAGS, npmExfiltration, npmHostTags } from '../../files/hosts.js'
import { lineOf } from '../../files/script.js'
import { installOf, scriptFinds } from './commands.js'

// What of a workflow's expressions anyone can write (a title, a body, a
// branch's name, a commit's message), which a script runs as its own code, and the events a workflow runs on with
// its secrets for a fork's or anyone's.
const PRIVILEGED_TRIGGERS = new Set(['pull_request_target', 'workflow_run', 'issue_comment', 'issues', 'discussion', 'discussion_comment',
  'pull_request_review', 'pull_request_review_comment', 'fork', 'watch'])

const INDEX = String.raw`(?:\s*\[[^\]]*\]|\.\*)`
const AUTHOR = String.raw`(?:author|committer)\.(?:email|name)`
const UNTRUSTED = new RegExp(String.raw`\bgithub\s*\.\s*(?:head_ref|event\s*\.\s*(?:`
  + [String.raw`issue\.(?:title|body)`,
    String.raw`pull_request\.(?:title|body|head\.(?:ref|label|repo\.default_branch))`,
    String.raw`(?:comment|review|review_comment)\.body`,
    String.raw`pages${INDEX}\.page_name`,
    String.raw`commits${INDEX}\.(?:message|${AUTHOR})`,
    String.raw`head_commit\.(?:message|${AUTHOR})`,
    String.raw`workflow_run\.(?:head_branch|display_title|head_commit\.(?:message|${AUTHOR})|pull_requests${INDEX}\.head\.ref)`,
    String.raw`discussion\.(?:title|body)`].join('|')
  + String.raw`))(?![\w-])`, 'gu')

// Each expression anyone can write in a script's `text`, a finding with
// the `index` its `${{` is at: red where the workflow runs with its secrets
// for anyone (`triggers`), else orange.
export function scriptInjections(text, triggers) {
  if (typeof text !== 'string' || !text.includes('${{')) return []
  const severity = triggers.some(event => PRIVILEGED_TRIGGERS.has(event)) ? 'critical' : 'high'
  return [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/gu)].flatMap(({ 1: inner, index }) =>
    [...inner.matchAll(UNTRUSTED)].map(({ 0: expression }) => ({ id: 'script-injection', severity, expression: expression.replaceAll(/\s+/gu, ''), index })))
}

// A ref naming a pull request's own code, as `actions/checkout` checks it out.
const PULL_HEAD = /\bgithub\s*\.\s*(?:head_ref|event\s*\.\s*(?:pull_request\s*\.\s*head\s*\.\s*(?:sha|ref)|workflow_run\s*\.\s*head_(?:sha|branch)|number|pull_request\s*\.\s*number))\b|refs\/pull\//u
export const namesPullHead = text => typeof text === 'string' && PULL_HEAD.test(text)

// Programs whose package is named otherwise: `npx tsc` runs typescript's.
const KNOWN_BINS = new Map([['tsc', 'typescript'], ['tsserver', 'typescript'], ['ng', '@angular/cli'], ['nest', '@nestjs/cli'],
  ['changeset', '@changesets/cli'], ['biome', '@biomejs/biome'], ['svelte-kit', '@sveltejs/kit'], ['api-extractor', '@microsoft/api-extractor'],
  ['commitlint', '@commitlint/cli'], ['attw', '@arethetypeswrong/cli'], ['ncu', 'npm-check-updates'], ['vue-cli-service', '@vue/cli-service'],
  ['firebase', 'firebase-tools'], ['netlify', 'netlify-cli'], ['cdk', 'aws-cdk'], ['sls', 'serverless'], ['playwright', '@playwright/test'],
  ['eas', 'eas-cli'], ['expo', 'expo'], ['vsce', '@vscode/vsce'], ['wdio', '@wdio/cli'], ['lhci', '@lhci/cli'], ['tsx', 'tsx'], ['webpack', 'webpack-cli']])
const PACKAGING = new Set(['pip', 'setuptools', 'wheel'])

// Whether `locked` (a Set) has what npx runs by `name`, or the package giving it.
export const lockedName = (locked, name) => locked.has(name) || (KNOWN_BINS.has(name) && locked.has(KNOWN_BINS.get(name)))

// How severe fetching a package is; null for none.
function packageSeverity(found, { locked, installed, external }) {
  const runsOwn = found.ecosystem === 'npm' && found.localFirst && found.registry && (found.spec === null || found.exact)
  if (runsOwn && (external ? installed : locked && installed)) return null
  if (found.ecosystem === 'go' && found.exact) return null
  if (found.ecosystem === 'crates' && found.exact && found.locked) return null
  if (found.ecosystem === 'pypi' && PACKAGING.has(found.name.toLowerCase())) return 'notice'
  // A version a variable names may be one, set elsewhere in the workflow.
  return found.exact || found.spec?.includes('$') ? 'moderate' : 'high'
}

const packageOf = ({ tool, name, spec, localFirst }) => ({ tool, name, spec, ...localFirst ? { localFirst } : {} })

// The findings of one find of a script.
function graded(found, context) {
  if (found.kind === 'package') {
    const locked = found.ecosystem === 'npm' && found.localFirst ? context.locked(found.name) : false
    const severity = packageSeverity(found, { locked, installed: context.installed, external: context.external })
    return severity ? [{ id: 'fetched-package', severity, ...packageOf(found), ...found.localFirst ? { locked, installed: context.installed } : {} }] : []
  }
  if (found.kind === 'unlocked-install') return [{ id: 'unlocked-install', severity: /^(?:yarn|bun)\b/u.test(found.tool) ? 'low' : 'moderate', tool: found.tool }]
  if (found.kind === 'remote-script') return [{ id: 'remote-script', severity: 'high', command: found.command }]
  if (found.kind === 'image') return found.read?.digest ? [] : [imageFinding(found.text, found.read)]
  return found.kind === 'clone' ? [{ id: 'clone', severity: 'low', url: found.url }] : []
}

// An image run by a tag: orange with none or `latest`, else yellow.
export const imageFinding = (text, read) => ({ id: 'unpinned-image', severity: !read || read.tag === null || read.tag === 'latest' ? 'high' : 'moderate', image: text })

// The file's line a script's line is on: a `|` block scalar's own, else `run:`'s.
const fileLine = (run, line) => run.start === null ? run.line : run.start + line

// Every finding of a `run` script (workflow.js runOf); `context`'s `locked(name)`
// whether a lockfile there locks it, `installed` whether an install ran before.
export function scriptFindings(run, context) {
  const findings = []
  // An install earlier in the script, in its own directory, counts as one in a step before.
  const install = installOf(run.script)
  for (const found of scriptFinds(run.script)) {
    const before = context.installed || (install !== null && install.into === null && install.order < found.order)
    for (const finding of graded(found, { ...context, installed: before })) findings.push({ ...finding, line: fileLine(run, found.line) })
  }
  for (const [tag, services] of npmHostTags(npmExfiltration('run.sh', run.script, true))) {
    findings.push({ id: 'hosts', severity: HOST_TAGS.get(tag), tag, services: [...services.keys()], line: fileLine(run, Math.min(...[...services.values()].flat()) - 1) })
  }
  const line = lineOf(run.script)
  for (const { index, ...finding } of scriptInjections(run.script, context.triggers)) findings.push({ ...finding, line: fileLine(run, line(index) - 1) })
  return findings
}
