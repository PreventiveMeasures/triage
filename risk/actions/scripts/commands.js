// What a `run:` script fetches and runs past what a lockfile or a digest pins,
// command by command (shell.js), each with its line in the script from 0.
import { NPM_INSTALLS, fetched, npmToolFinds, optionsOf, projectOf, valuesOf } from './packages.js'
import { pathFrom, scriptCommands, scriptLines } from './shell.js'
import { SHELLS as SHELL_NAMES } from '../../files/runs-code.js'
import { readImage } from '../uses.js'

// A program's file name, lowercase, past its directory and a Windows extension.
const programOf = word => (word ?? '').split(/[/\\]/u).at(-1).toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$|@[\w.-]*$/u, '')

const SHELLS = new RegExp(String.raw`^(?:${SHELL_NAMES}|python[\d.]*|node|perl|ruby|php|iex|invoke-expression)$`, 'u')
const FETCHERS = /^(?:curl|wget|irm|iwr|invoke-restmethod|invoke-webrequest)$/u
// A script fetched and run on one line: `<(curl …)`, `-c "$(curl …)"`, `iex (irm …)`.
const FETCHED_AND_RUN = [
  /\b(?:(?:ba|z|da|k)?sh|source|\.)\s+(?:-\S+\s+)*<\(\s*(?:curl|wget)\b/iu,
  /\b(?:(?:ba|z|da|k)?sh|python[\d.]*|node|perl|ruby)\s+(?:-\S+\s+)*-c\s+["']?\$\(\s*(?:curl|wget)\b/iu,
  /\b(?:iex|invoke-expression)\b[^|;]*\b(?:irm|iwr|invoke-restmethod|invoke-webrequest|downloadstring)\b/iu,
]

// The file curl or wget saves to (`-o f`, `-of`, `--output f`, curl's `-O`,
// wget's by its URL), or PowerShell's (`-OutFile f`); else null.
function savedTo(program, argv) {
  for (let at = 1; at < argv.length; at++) {
    const outFile = /^-outfile(?::(.+))?$/iu.exec(argv[at]), word = argv[at]
    if (outFile && !/^(?:curl|wget)$/u.test(program)) return outFile[1] ?? argv[at + 1] ?? null
    const attached = { curl: /^-[a-zA-Z]*o(.+)$/u, wget: /^-[a-zA-Z]*O(.+)$/u }[program]?.exec(word)
    if (attached) return attached[1] === '-' ? null : attached[1]
    if (program === 'curl' && (/^-[a-zA-Z]*o$/u.test(word) || word === '--output')) return argv[at + 1] ?? null
    if (program === 'wget' && (/^-[a-zA-Z]*O$/u.test(word) || word === '--output-document')) return argv[at + 1] === '-' ? null : argv[at + 1] ?? null
    const joined = /^(?:--output|--output-document)=(.+)$/u.exec(word)
    if (joined) return joined[1]
  }
  const url = program === 'wget' || (program === 'curl' && argv.some(word => /^-[a-zA-Z]*O[a-zA-Z]*$/u.test(word) || word === '--remote-name')) ? argv.find(word => /^https?:\/\//u.test(word)) : null
  return url ? URL.parse(url)?.pathname.split('/').at(-1) || null : null
}

// Whether a command runs `file`, as a program or a shell's script.
function runsFile({ argv }, file) {
  const name = file.replace(/^\.\//u, '')
  const ran = argv[0].replace(/^\.\//u, '')
  if (ran === name || argv[0] === file) return true
  return (SHELLS.test(programOf(argv[0])) || argv[0] === 'source' || argv[0] === '.') && argv.slice(1).some(word => word.replace(/^\.\//u, '') === name)
}

const pythonPackage = text => {
  if (/^(?:git\+|https?:|file:|\.{0,2}\/)/iu.test(text)) return { name: text, spec: null, exact: /@[\da-f]{40}(?:#|$)/u.test(text), registry: false }
  const m = /^([\w.-]+)(?:\[[^\]]*\])?\s*(.*)$/u.exec(text)
  return m && { name: m[1], spec: m[2] || null, exact: /^===?\s*[\w.!+-]+$/u.test(m[2]), registry: true }
}

// The packages pip installs by name, not a requirements file's or a path.
const PIP_VALUED = /^(?:-r|--requirement|-c|--constraint|-e|--editable|-i|--index-url|--extra-index-url|-t|--target|--prefix|--root|-f|--find-links)$/u
const pip = (tool, argv, from) => optionsOf(argv, from, PIP_VALUED).operands.filter(word => !/^\.{1,2}(?:\/|$)/u.test(word))
  .flatMap(text => fetched(tool, pythonPackage(text), { ecosystem: 'pypi' }))
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
    const options = optionsOf(argv, program === 'uvx' ? 1 : 3, /^--(?:from|python|with)$/u), [spec] = [...valuesOf(options, '--from'), ...options.operands]
    return fetched(program === 'uvx' ? 'uvx' : `uv tool ${argv[2]}`, spec && pythonPackage(spec), { ecosystem: 'pypi' })
  }
  if (program === 'pipx' && /^(?:run|install)$/u.test(argv[1] ?? '')) {
    const options = optionsOf(argv, 2, /^--(?:spec|python)$/u), [spec] = [...valuesOf(options, '--spec'), ...options.operands]
    return fetched(`pipx ${argv[1]}`, spec && pythonPackage(spec), { ecosystem: 'pypi' })
  }
  return []
}


const EXACT_SEMVER = text => /^=?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(text)

// `go install x@v y@v`, `go run x@v`, a version held to Go's checksum database.
function go(argv) {
  const { operands } = optionsOf(argv, 2, /^-(?:o|modfile|tags|ldflags|gcflags|C)$/u)
  return (argv[1] === 'run' ? operands.slice(0, 1) : operands).filter(target => target.includes('@'))
    .flatMap(target => fetched(`go ${argv[1]}`, atVersion(target, spec => /^v\d+\.\d+\.\d+/u.test(spec)), { ecosystem: 'go' }))
}

// `cargo install`: each crate by its version, or a repository by its commit;
// `locked` with `--locked`.
function cargo(argv) {
  if (argv.includes('--path')) return []
  const options = optionsOf(argv, 2, /^--(?:version|git|branch|rev|tag|root|features|registry|index|bin|example|target|profile|jobs)$|^-[jF]$/u)
  const [git = null] = valuesOf(options, '--git'), [version = null] = valuesOf(options, '--version'), [ref = null] = valuesOf(options, '--rev', '--tag', '--branch')
  const specs = git ? [{ name: git, spec: ref, exact: valuesOf(options, '--rev').length > 0, registry: false }] : options.operands.map(crate => atVersion(crate, EXACT_SEMVER))
  return specs.flatMap(spec => fetched(`cargo ${argv[1]}`, { ...spec, spec: spec.spec ?? version, exact: spec.exact || (!git && EXACT_SEMVER(version ?? '')), locked: argv.includes('--locked') }, { ecosystem: 'crates' }))
}

// `gem install x [-v 1.2.3]`.
function gem(argv) {
  const options = optionsOf(argv, 2, /^(?:-v|--version|-i|--install-dir|-s|--source|-n|--bindir)$/u), [version = null] = valuesOf(options, '-v', '--version')
  return options.operands.flatMap(name => fetched('gem install', { name, spec: version, exact: /^=?\s*\d+(?:\.\d+)+$/u.test(version ?? ''), registry: true }, { ecosystem: 'rubygems' }))
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
// An install's options that leave the project's node_modules as they are.
const NOT_LOCAL = /^(?:-g|--location=global|--(?:global|package-lock-only|lockfile-only|dry-run)(?:=true)?)$/u

// A script's installs of a project's packages: each one's `order`, the
// directory it installs into, by its `cd`s and the one it names (`into`, a
// path from the step's, '' for it), and whether it leaves devDependencies out
// (`prod`), by an option or NODE_ENV production (the step's `production`).
export function installsOf(script, production = false) {
  const found = []
  let exported = production
  for (const { argv, dir, env, order } of scriptCommands(script)) {
    const program = programOf(argv[0])
    if (program === 'export') for (const word of argv) if (word.startsWith('NODE_ENV=')) exported = word === 'NODE_ENV=production'
    const options = optionsOf(argv, 1), [command] = options.operands
    if (argv.some(word => NOT_LOCAL.test(word)) || !(program === 'yarn' ? command === undefined || command === 'install' : INSTALLS[program]?.test(command ?? ''))) continue
    // npm installs what `--include` names whatever leaves it out.
    const prod = !valuesOf(options, '--include').includes('dev') && (valuesOf(options, '--omit').includes('dev') || /^prod(?:uction)?$/u.test(valuesOf(options, '--only')[0] ?? '')
      || argv.some(word => /^--prod(?:uction)?$/u.test(word)) || (env.NODE_ENV ?? (exported ? 'production' : '')) === 'production')
    const project = projectOf(argv)
    found.push({ order, into: project === null ? dir : pathFrom(dir, project), prod })
  }
  return found
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
    if (FETCHERS.test(program) && command.pipedTo.some(each => SHELLS.test(programOf(each.argv[0])))) found.push({ kind: 'remote-script', line: command.line, command: excerpt(lines.get(command.line) ?? '') })
    const file = FETCHERS.test(program) ? savedTo(program, command.argv) ?? command.out : null
    if (file) saved.set(file, command.line)
    for (const [name, at] of saved) {
      if (FETCHERS.test(program) || !runsFile(command, name)) continue
      found.push({ kind: 'remote-script', line: command.line, command: excerpt(lines.get(at) ?? '') })
      saved.delete(name)
    }
    for (const each of commandFinds(command)) found.push({ ...each, line: command.line, order: command.order, dir: command.dir })
  }
  const told = new Set()
  return found.filter(({ order: _order, ...each }) => { const key = JSON.stringify(each); return !told.has(key) && told.add(key) }).toSorted((a, b) => a.line - b.line)
}
