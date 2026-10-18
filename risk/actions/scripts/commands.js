// What a `run:` script fetches and runs past what a lockfile or a digest pins,
// command by command (shell.js), each with its line in the script from 0.
import { NPM_INSTALLS, fetched, npmToolFinds, positional, projectOf } from './packages.js'
import { scriptCommands, scriptLines } from './shell.js'
import { SHELLS as SHELL_NAMES } from '../../files/runs-code.js'
import { readImage } from '../uses.js'

// A program's file name, lowercase, past its directory and a Windows extension.
const programOf = word => (word ?? '').split(/[/\\]/u).at(-1).toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/u, '')

const SHELLS = new RegExp(String.raw`^(?:${SHELL_NAMES}|python[\d.]*|node|perl|ruby|php|iex|invoke-expression)$`, 'u')
const FETCHERS = /^(?:curl|wget|irm|iwr|invoke-restmethod|invoke-webrequest)$/u
// A script fetched and run on one line: `<(curl …)`, `-c "$(curl …)"`, `iex (irm …)`.
const FETCHED_AND_RUN = [
  /\b(?:(?:ba|z|da|k)?sh|source|\.)\s+(?:-\S+\s+)*<\(\s*(?:curl|wget)\b/iu,
  /\b(?:(?:ba|z|da|k)?sh|python[\d.]*|node|perl|ruby)\s+(?:-\S+\s+)*-c\s+["']?\$\(\s*(?:curl|wget)\b/iu,
  /\b(?:iex|invoke-expression)\b[^|;]*\b(?:irm|iwr|invoke-restmethod|invoke-webrequest|downloadstring)\b/iu,
]

// The file curl or wget saves to (`-o f`, `--output f`, curl's `-O`), or null.
function savedTo(program, argv) {
  for (let at = 1; at < argv.length; at++) {
    const word = argv[at]
    if (program === 'curl' && (/^-[a-zA-Z]*o$/u.test(word) || word === '--output')) return argv[at + 1] ?? null
    if (program === 'wget' && (/^-[a-zA-Z]*O$/u.test(word) || word === '--output-document')) return argv[at + 1] === '-' ? null : argv[at + 1] ?? null
    const joined = /^(?:--output|--output-document)=(.+)$/u.exec(word)
    if (joined) return joined[1]
  }
  const url = program === 'curl' && argv.some(word => /^-[a-zA-Z]*O[a-zA-Z]*$/u.test(word) || word === '--remote-name') ? argv.find(word => /^https?:\/\//u.test(word)) : null
  return url ? URL.parse(url)?.pathname.split('/').at(-1) || null : null
}

// Whether a command runs `file`, as a program or a shell's script.
function runsFile({ argv }, file) {
  const name = file.replace(/^\.\//u, '')
  const ran = argv[0].replace(/^\.\//u, '')
  if (ran === name || argv[0] === file) return true
  return SHELLS.test(programOf(argv[0])) && argv.slice(1).some(word => word.replace(/^\.\//u, '') === name)
}

const pythonPackage = text => {
  if (/^(?:git\+|https?:|file:|\.{0,2}\/)/iu.test(text)) return { name: text, spec: null, exact: /@[\da-f]{40}(?:#|$)/u.test(text), registry: false }
  const m = /^([\w.-]+)(?:\[[^\]]*\])?\s*(.*)$/u.exec(text)
  return m && { name: m[1], spec: m[2] || null, exact: /^===?\s*[\w.!+-]+$/u.test(m[2]), registry: true }
}

// The packages pip installs by name, not a requirements file's or a path.
function pip(tool, argv, from) {
  const named = []
  for (let at = from; at < argv.length; at++) {
    if (/^(?:-r|--requirement|-c|--constraint|-e|--editable|-i|--index-url|--extra-index-url|-t|--target|--prefix|--root|-f|--find-links)$/u.test(argv[at])) at++
    else if (!argv[at].startsWith('-') && !/^\.{1,2}(?:\/|$)/u.test(argv[at])) named.push(argv[at])
  }
  return named.flatMap(text => fetched(tool, pythonPackage(text), { ecosystem: 'pypi' }))
}

const firstArg = (argv, from) => argv.slice(from).find(word => !word.startsWith('-')) ?? null
// A package named `name@version`, as Go's, crates' and Deno's are.
const atVersion = (text, exact) => {
  const at = text.lastIndexOf('@')
  const spec = at > 0 ? text.slice(at + 1) : null
  return { name: at > 0 ? text.slice(0, at) : text, spec, exact: spec !== null && exact(spec), registry: true }
}

function python(program, argv) {
  if (program === 'pip' || /^pip\d/u.test(program)) return argv[1] === 'install' ? pip(program, argv, 2) : []
  if (/^python[\d.]*$/u.test(program) && argv[1] === '-m' && /^pip\d?$/u.test(argv[2] ?? '') && argv[3] === 'install') return pip(`${program} -m pip`, argv, 4)
  if (program === 'uv' && argv[1] === 'pip' && argv[2] === 'install') return pip('uv pip', argv, 3)
  if (program === 'uvx' || (program === 'uv' && argv[1] === 'tool' && /^(?:run|install)$/u.test(argv[2] ?? ''))) {
    const from = program === 'uvx' ? 1 : 3
    const spec = argv.includes('--from') ? argv[argv.indexOf('--from') + 1] : firstArg(argv, from)
    return fetched(program === 'uvx' ? 'uvx' : `uv tool ${argv[2]}`, spec && pythonPackage(spec), { ecosystem: 'pypi' })
  }
  if (program === 'pipx' && /^(?:run|install)$/u.test(argv[1] ?? '')) {
    const spec = argv.includes('--spec') ? argv[argv.indexOf('--spec') + 1] : firstArg(argv, 2)
    return fetched(`pipx ${argv[1]}`, spec && pythonPackage(spec), { ecosystem: 'pypi' })
  }
  return []
}

// An option's value (`--version 1.2.3`, `--version=1.2.3`), or null.
function valueOf(argv, names) {
  for (let at = 1; at < argv.length; at++) {
    if (names.test(argv[at])) return argv[at + 1] ?? null
    const joined = /^(--[\w-]+)=(.*)$/u.exec(argv[at])
    if (joined && names.test(joined[1])) return joined[2]
  }
  return null
}

// The words past `from` that aren't options or `valued`'s values.
const operands = (argv, from, valued) => argv.slice(from).filter((word, at, words) => !word.startsWith('-') && !valued.test(words[at - 1] ?? ''))

const EXACT_SEMVER = text => /^=?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(text)

// `go install|run x@v`, a version held to Go's checksum database.
function go(argv) {
  const target = operands(argv, 2, /^-(?:o|modfile|tags|ldflags|gcflags|C)$/u)[0]
  return target?.includes('@') ? fetched(`go ${argv[1]}`, atVersion(target, spec => /^v\d+\.\d+\.\d+/u.test(spec)), { ecosystem: 'go' }) : []
}

// `cargo install`: a crate by its version, or a repository by its commit;
// `locked` with `--locked`.
function cargo(argv) {
  if (argv.includes('--path')) return []
  const git = valueOf(argv, /^--git$/u)
  const crate = operands(argv, 2, /^--(?:version|git|branch|rev|tag|root|features|registry|index|bin|example|target|profile|jobs)$|^-[jF]$/u)[0]
  if (!crate && !git) return []
  const version = valueOf(argv, /^--version$/u)
  const spec = git ? { name: git, spec: valueOf(argv, /^--(?:rev|tag|branch)$/u), exact: valueOf(argv, /^--rev$/u) !== null, registry: false }
    : atVersion(crate, EXACT_SEMVER)
  return fetched(`cargo ${argv[1]}`, { ...spec, spec: spec.spec ?? version, exact: spec.exact || (!git && EXACT_SEMVER(version ?? '')), locked: argv.includes('--locked') }, { ecosystem: 'crates' })
}

// `gem install x [-v 1.2.3]`.
function gem(argv) {
  const version = valueOf(argv, /^(?:-v|--version)$/u)
  return operands(argv, 2, /^(?:-v|--version|-i|--install-dir|-s|--source|-n|--bindir)$/u)
    .flatMap(name => fetched('gem install', { name, spec: version, exact: /^=?\s*\d+(?:\.\d+)+$/u.test(version ?? ''), registry: true }, { ecosystem: 'rubygems' }))
}

// `deno run|install|x` of a URL or a registry's package.
function deno(argv) {
  const target = argv.slice(2).find(word => /^(?:https?:\/\/|npm:|jsr:)/u.test(word))
  if (!target) return []
  return fetched(`deno ${argv[1]}`, /^(?:npm|jsr):/u.test(target) ? atVersion(target.replace(/^(?:npm|jsr):/u, ''), EXACT_SEMVER)
    : { name: target, spec: null, exact: /@v?\d+\.\d+\.\d+/u.test(target), registry: false }, { ecosystem: 'deno' })
}

function others(program, argv) {
  if (program === 'go' && /^(?:install|run)$/u.test(argv[1] ?? '')) return go(argv)
  if (program === 'cargo' && /^(?:install|binstall)$/u.test(argv[1] ?? '')) return cargo(argv)
  if (program === 'gem' && argv[1] === 'install') return gem(argv)
  return program === 'deno' && /^(?:run|install|x|compile)$/u.test(argv[1] ?? '') ? deno(argv) : []
}

// What a command fetches or runs unpinned, but a script fetched and run.
function commandFinds(command) {
  const { argv } = command
  const program = programOf(argv[0])
  if (/^(?:docker|podman)$/u.test(program) && /^(?:run|pull|create)$/u.test(argv[1] ?? '')) {
    const image = argv.slice(2).find((word, at, words) => !word.startsWith('-') && !/^(?:-[evpwulhm]|--(?:env|volume|publish|workdir|user|label|hostname|memory|name|network|entrypoint|platform|mount|env-file|cpus|add-host|cap-add|device|dns|gpus|ipc|pid|restart|runtime|security-opt|shm-size|tmpfs|ulimit|volumes-from|log-driver))$/u.test(words[at - 1] ?? ''))
    return image ? [{ kind: 'image', text: image, read: readImage(image) }] : []
  }
  if (program === 'git' && argv[1] === 'clone') return [{ kind: 'clone', url: argv.slice(2).find(word => /^(?:https?:|git@|git:|ssh:)/u.test(word)) ?? null }]
  return [...npmToolFinds(program, argv), ...python(program, argv), ...others(program, argv)]
}

const INSTALLS = { npm: new RegExp(`^(?:ci|clean-install|ic|install-clean|${NPM_INSTALLS})$`, 'u'), pnpm: /^(?:i|install|add)$/u, bun: /^(?:i|install|add)$/u }

// A script's first install of a project's packages: its line, from 0, and the
// directory it names (`into`, packages.js projectOf); else null.
export function installOf(script) {
  for (const { argv, line } of scriptCommands(script)) {
    const program = programOf(argv[0])
    const command = positional(argv, 1)[0]
    if (program === 'yarn' ? command === undefined || command === 'install' : INSTALLS[program]?.test(command ?? '')) return { line, into: projectOf(argv) }
  }
  return null
}

// A script's line, as a finding names what it runs, cut short.
const excerpt = text => { const trimmed = text.trim().replaceAll(/\s+/gu, ' '); return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed }

// Everything a script fetches and runs past a pin, in its order.
export function scriptFinds(script) {
  const found = []
  const lines = new Map(scriptLines(script).map(({ text, line }) => [line, text]))
  for (const [line, text] of lines) {
    if (FETCHED_AND_RUN.some(pattern => pattern.test(text))) found.push({ kind: 'remote-script', line, command: excerpt(text) })
  }
  const saved = new Map()
  for (const command of scriptCommands(script)) {
    const program = programOf(command.argv[0])
    if (FETCHERS.test(program) && command.next && SHELLS.test(programOf(command.next.argv[0]))) found.push({ kind: 'remote-script', line: command.line, command: excerpt(lines.get(command.line) ?? '') })
    const file = FETCHERS.test(program) ? savedTo(program, command.argv) ?? command.out : null
    if (file) saved.set(file, command.line)
    for (const [name, at] of saved) {
      if (FETCHERS.test(program) || !runsFile(command, name)) continue
      found.push({ kind: 'remote-script', line: command.line, command: excerpt(lines.get(at) ?? '') })
      saved.delete(name)
    }
    for (const each of commandFinds(command)) found.push({ ...each, line: command.line })
  }
  const told = new Set()
  return found.filter(each => { const key = JSON.stringify(each); return !told.has(key) && told.add(key) }).toSorted((a, b) => a.line - b.line)
}
