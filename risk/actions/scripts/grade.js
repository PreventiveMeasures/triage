// What a `run:` script fetches and runs (commands.js), graded (README.md).
import { HOST_TAGS, npmExfiltration, npmHostTags } from '../../files/hosts.js'
import { lineOf } from '../../files/script.js'
import { installsOf, scriptFinds } from './commands.js'

// The events a workflow runs on with its secrets for anyone's pull request.
const PRIVILEGED_TRIGGERS = new Set(['pull_request_target', 'workflow_run', 'issue_comment', 'issues', 'discussion', 'discussion_comment',
  'pull_request_review', 'pull_request_review_comment', 'fork', 'watch'])

// The expressions anyone can write: a title, a body, a branch's name, a
// commit's message, a fork's description.
const INDEX = String.raw`(?:\s*\[[^\]]*\]|\.\*)`
const AUTHOR = String.raw`(?:author|committer)\.(?:email|name)`
const UNTRUSTED = new RegExp(String.raw`\bgithub\s*\.\s*(?:head_ref|event\s*\.\s*(?:`
  + [String.raw`issue\.(?:title|body)`,
    String.raw`pull_request\.(?:title|body|head\.(?:ref|label|repo\.(?:default_branch|description|homepage)))`,
    String.raw`(?:comment|review|review_comment)\.body`,
    String.raw`pages${INDEX}\.page_name`,
    String.raw`commits${INDEX}\.(?:message|${AUTHOR})`,
    String.raw`head_commit\.(?:message|${AUTHOR})`,
    String.raw`workflow_run\.(?:head_branch|display_title|head_commit\.(?:message|${AUTHOR})|head_repository\.(?:description|homepage|default_branch)|pull_requests${INDEX}\.head\.ref)`,
    String.raw`discussion\.(?:title|body)`].join('|')
  + String.raw`))(?![\w-])`, 'gu')

// An expression with its index syntax's properties (`github['event']`) as
// dereferences, as GitHub reads either.
const dotted = text => text.replaceAll(/\[\s*'([\w-]+)'\s*\]/gu, '.$1')

// Each expression anyone can write in a script's `text`, a finding with
// the `index` its `${{` is at: red where the workflow runs with its secrets
// for anyone (`triggers`), else orange.
export function scriptInjections(text, triggers) {
  if (typeof text !== 'string' || !text.includes('${{')) return []
  const severity = triggers.some(event => PRIVILEGED_TRIGGERS.has(event)) ? 'critical' : 'high'
  return [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/gu)].flatMap(({ 1: inner, index }) =>
    [...dotted(inner).matchAll(UNTRUSTED)].map(({ 0: expression }) => ({ id: 'script-injection', severity, expression: expression.replaceAll(/\s+/gu, ''), index })))
}

// A ref or a repository naming a pull request's own code, as
// `actions/checkout` checks it out: its head's commit or branch (a
// `workflow_run`'s pull requests' too), or the fork's repository, whose
// default branch it is then.
const PULL_HEAD = new RegExp(String.raw`\bgithub\.(?:head_ref|event\.(?:number|pull_request\.(?:number|merge_commit_sha|head\.(?:sha|ref|repo\.(?:full_name|owner\.login)))|workflow_run\.(?:head_sha|head_branch|pull_requests\[[^\]]*\]\.head\.(?:sha|ref)|head_repository\.(?:full_name|owner\.login))))\b`
  .replaceAll('\\.', String.raw`\s*\.\s*`) + String.raw`|refs\/pull\/`, 'u')
export const namesPullHead = text => typeof text === 'string' && PULL_HEAD.test(dotted(text))

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

// The findings of one find of a script, `locked` what a lockfile says of it.
function graded(found, context, locked) {
  if (found.kind === 'package') {
    const { tool, name, spec, localFirst } = found, installed = context.installed
    const severity = packageSeverity(found, { locked, installed, external: context.external })
    return severity ? [{ id: 'fetched-package', severity, tool, name, spec, ...localFirst ? { localFirst, locked, installed } : {} }] : []
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

// Whether `dir` is `directory` or above it, as node finds a package there;
// null for anywhere.
export const within = (dir, directory) => dir === null || dir === '' || directory === dir || directory.startsWith(`${dir}/`)

// Every finding of a `run` script (workflow.js runOf); `context`'s
// `locked(name, dir)` whether a lockfile there locks it (`dev` where
// devDependencies alone need it), `installed(dev, dir)` whether an install
// ran before that installs such a package there, `dir` a path from the
// step's directory, as a `cd` moves to.
export function scriptFindings(run, context) {
  const findings = []
  // An install earlier in the script counts as one in a step before.
  const installs = installsOf(run.script, run.production)
  for (const found of scriptFinds(run.script)) {
    const dir = found.dir ?? ''
    const locked = found.kind === 'package' && found.ecosystem === 'npm' && found.localFirst && context.locked(found.exact ? `${found.name}@${found.spec.replace(/^[v=]/u, '')}` : found.name, dir)
    const before = context.installed(locked === 'dev', dir) || installs.some(({ order, into, prod }) => order < found.order && within(into, dir) && !(prod && locked === 'dev'))
    for (const finding of graded(found, { ...context, installed: before }, Boolean(locked))) findings.push({ ...finding, line: fileLine(run, found.line) })
  }
  for (const [tag, services] of npmHostTags(npmExfiltration('run.sh', run.script, true))) {
    findings.push({ id: 'hosts', severity: HOST_TAGS.get(tag), tag, services: [...services.keys()], line: fileLine(run, Math.min(...[...services.values()].flat()) - 1) })
  }
  const line = lineOf(run.script)
  for (const { index, ...finding } of scriptInjections(run.script, context.triggers)) findings.push({ ...finding, line: fileLine(run, line(index) - 1) })
  return findings
}
