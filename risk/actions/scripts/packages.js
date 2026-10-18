// What a command of npm's tools fetches and runs past what a lockfile locks
// (commands.js), npx's and its kin's the project's own where installed
// (`localFirst`), and an install that resolves anew (`unlocked`).
import { isExactVersion } from '@preventive/upstream/semver.js'

// A package spec's name and spec, `exact` for a version, `registry: false` for
// a URL, a path, git or a GitHub shorthand.
export function npmSpec(text) {
  if (/^(?:\.{0,2}\/|~|[a-z][\w+.-]*:|[\w.-]+\/[\w.-]+(?:#.*)?$)/iu.test(text) && !/^@[\w.-]+\//u.test(text)) {
    return { name: text, spec: null, exact: false, registry: false }
  }
  const at = text.indexOf('@', text.startsWith('@') ? 1 : 0)
  const name = at === -1 ? text : text.slice(0, at)
  const spec = at === -1 ? null : text.slice(at + 1)
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/u.test(name)) return null
  return { name, spec, exact: spec !== null && isExactVersion(spec.replace(/^[v=]/u, '')), registry: true }
}

// A package a tool fetches, as a script's find; none for none.
export const fetched = (tool, spec, { ecosystem = 'npm', localFirst = false, ...more } = {}) => spec ? [{ kind: 'package', tool, ecosystem, localFirst, ...more, ...spec }] : []

// What `npm create x` runs: `create-x`, `@s/create` for `@s`, `@s/create-x`.
function createPackage(text) {
  const scoped = /^(@[\w.-]+)(?:@(.+))?$/u.exec(text)
  if (scoped) return npmSpec(`${scoped[1]}/create${scoped[2] ? `@${scoped[2]}` : ''}`)
  const spec = npmSpec(text)
  if (!spec?.registry) return spec
  const [scope, name] = spec.name.startsWith('@') ? spec.name.split('/') : [null, spec.name]
  const named = scope ? (name ? `${scope}/create-${name}` : `${scope}/create`) : `create-${name}`
  return { ...spec, name: named }
}

// Options of npm's tools that take a value.
const VALUED = /^(?:-[pcwC]|--(?:package|call|cache|userconfig|registry|workspace|prefix|filter|dir|global-dir|store-dir|loglevel|cwd|spec|location))$/u
const GLOBAL = /^(?:-g|--global|--location=global)$/u

// The words past `from` that aren't options or their values, and all past `--`.
export function positional(argv, from) {
  const words = []
  for (let at = from; at < argv.length; at++) {
    const word = argv[at]
    if (word === '--') return [...words, ...argv.slice(at + 1)]
    if (VALUED.test(word)) at++
    else if (!word.startsWith('-')) words.push(word)
  }
  return words
}

// The packages `--package`/`-p` names (npx, `npm exec`, `pnpm dlx`).
function packageOptions(argv) {
  const named = []
  for (let at = 1; at < argv.length && argv[at] !== '--'; at++) {
    const m = /^--package=(.+)$/u.exec(argv[at])
    if (m) named.push(m[1])
    else if (argv[at] === '-p' || argv[at] === '--package') named.push(argv[++at] ?? '')
  }
  return named.filter(Boolean)
}

// What an exec (npx, `npm exec`, bunx, dlx) fetches: its `--package`s, else
// its command's; none with `--no`, `--offline`, or a command line (`-c`).
function execPackages(tool, argv, from, localFirst) {
  if (argv.some(word => /^(?:--no|--no-install|--offline)$/u.test(word))) return []
  const named = packageOptions(argv)
  if (named.length === 0 && argv.some(word => word === '-c' || word === '--call')) return []
  return (named.length > 0 ? named : positional(argv, from).slice(0, 1)).flatMap(text => fetched(tool, npmSpec(text), { localFirst }))
}

// The directory an install names for its project (`--prefix`, `-C`, `--dir`,
// `--cwd`); null for the one it runs in, `.` too.
export function projectOf(argv) {
  for (let at = 1; at < argv.length && argv[at] !== '--'; at++) {
    const m = /^(?:-C|--prefix|--dir|--cwd)(?:=(.*))?$/u.exec(argv[at])
    const dir = m ? m[1] ?? argv[at + 1] ?? null : undefined
    if (dir !== undefined) return dir === null || /^\.\/?$/u.test(dir) ? null : dir
  }
  return null
}

const installs = (tool, words) => words.flatMap(text => fetched(tool, npmSpec(text)))
// npm's install command and its aliases (commands.js installsOf).
export const NPM_INSTALLS = 'i|in|ins|inst|insta|instal|install|isnt|isnta|isntal|isntall|add|it|install-test'
const created = (tool, text) => text ? fetched(tool, createPackage(text)) : []
const unlocked = tool => [{ kind: 'unlocked-install', tool }]
const isInstalled = word => /^(?:\.{1,2}(?:\/|$)|file:|link:|workspace:)/u.test(word)

function npm(argv) {
  const words = positional(argv, 1)
  const [command = '', ...rest] = words
  const at = argv.indexOf(command)
  if (command === 'exec' || command === 'x') return execPackages(`npm ${command}`, argv, at + 1, true)
  if (/^(?:create|init|innit)$/u.test(command)) return created(`npm ${command}`, rest[0])
  if (new RegExp(`^(?:${NPM_INSTALLS})$`, 'u').test(command)) {
    const named = rest.filter(word => !isInstalled(word))
    if (argv.some(word => GLOBAL.test(word))) return installs(`npm ${command} -g`, named)
    return named.length > 0 ? installs(`npm ${command}`, named) : unlocked(`npm ${command}`)
  }
  return /^(?:update|up|upgrade|udpate)$/u.test(command) ? unlocked(`npm ${command}`) : []
}

// pnpm's and bun's, by the word each runs a package with (`exec`), what an
// install resolving anew is told by (`anew`, null for none), and its updates.
const pnpmLike = (program, exec, localFirst, anew, updates) => argv => {
  const [command = '', ...rest] = positional(argv, 1)
  if (command === exec) return execPackages(`${program} ${exec}`, argv, argv.indexOf(exec) + 1, localFirst)
  if (command === 'create') return created(`${program} create`, rest[0])
  const global = argv.some(word => GLOBAL.test(word)), installing = command === 'install' || command === 'i'
  if (command === 'add' || (installing && rest.length > 0)) return installs(`${program} ${command}${global ? ' -g' : ''}`, rest.filter(word => !isInstalled(word)))
  if (installing && anew(argv) !== null) return unlocked(`${program} ${command}${anew(argv)}`)
  return updates.test(command) ? unlocked(`${program} ${command}`) : []
}
const pnpm = pnpmLike('pnpm', 'dlx', false, argv => argv.includes('--no-frozen-lockfile') ? ' --no-frozen-lockfile' : null, /^(?:update|up|upgrade)$/u)
const bun = pnpmLike('bun', 'x', true, argv => argv.some(word => word === '--frozen-lockfile' || word === '--ci') ? null : '', /^update$/u)

function yarn(argv) {
  const [command = '', ...rest] = positional(argv, 1)
  if (command === 'dlx') return execPackages('yarn dlx', argv, argv.indexOf('dlx') + 1, false)
  if (command === 'create') return created('yarn create', rest[0])
  if (command === 'global' && rest[0] === 'add') return installs('yarn global add', rest.slice(1))
  if (command === 'add') return installs('yarn add', rest.filter(word => !isInstalled(word)))
  const frozen = argv.some(word => /^--(?:frozen-lockfile|immutable)$/u.test(word))
  if ((command === '' || command === 'install') && !frozen) return unlocked(command ? 'yarn install' : 'yarn')
  return /^(?:upgrade|up)$/u.test(command) ? unlocked(`yarn ${command}`) : []
}

// The tools that run a package (whether one installed first), and the rest.
const EXECS = new Map([['npx', true], ['bunx', true], ['pnpx', false]])
const TOOLS = new Map([['npm', npm], ['pnpm', pnpm], ['yarn', yarn], ['bun', bun]])

// What a command of npm's tools fetches, by its program's name: packages and
// installs resolving anew.
export function npmToolFinds(program, argv) {
  if (EXECS.has(program)) return execPackages(program, argv, 1, EXECS.get(program))
  return TOOLS.get(program)?.(argv) ?? []
}
