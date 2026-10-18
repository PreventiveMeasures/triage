// What a command of npm's tools fetches and runs past what a lockfile locks
// (commands.js), npx's and its kin's the project's own where installed
// (`localFirst`), and an install that resolves anew (`unlocked`).
import { isExactVersion } from '@preventive/upstream/semver.js'

// A package spec (`name`, `name@spec`, `@scope/name@spec`) by its name and
// spec, `exact` where the spec is a version; `registry: false` for one of
// elsewhere (a URL, a path, git, a GitHub shorthand).
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

// A package a tool fetches (`spec`), as a find of a script is told
// (commands.js); none for none.
export const fetched = (tool, spec, { ecosystem = 'npm', localFirst = false, ...more } = {}) => spec ? [{ kind: 'package', tool, ecosystem, localFirst, ...more, ...spec }] : []

// The package `npm create x` and `npm init x` run: `create-x`, `@s/create`
// for `@s`, `@s/create-x` for `@s/x`, its spec kept.
function createPackage(text) {
  // A scope alone (`@s`, `@s@1.0.0`) names `@s/create`.
  const scoped = /^(@[\w.-]+)(?:@(.+))?$/u.exec(text)
  if (scoped) return npmSpec(`${scoped[1]}/create${scoped[2] ? `@${scoped[2]}` : ''}`)
  const spec = npmSpec(text)
  if (!spec?.registry) return spec
  const [scope, name] = spec.name.startsWith('@') ? spec.name.split('/') : [null, spec.name]
  const named = scope ? (name ? `${scope}/create-${name}` : `${scope}/create`) : `create-${name}`
  return { ...spec, name: named }
}

// Options of npm's tools that take a value, as their words read past them.
const VALUED = /^(?:-[pcwC]|--(?:package|call|cache|userconfig|registry|workspace|prefix|filter|dir|global-dir|store-dir|loglevel|cwd|spec|location))$/u
const GLOBAL = /^(?:-g|--global|--location=global)$/u

// The words of `argv` past `from` that aren't options, an option's value
// left out, and those after `--` all.
function positional(argv, from) {
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

// What an exec of packages (npx, `npm exec`, bunx, dlx) fetches: those
// `--package` names, else the command it runs; none where it may only run
// what is installed (`--no`, `--no-install`, `--offline`), or runs a command
// line (`-c`).
function execPackages(tool, argv, from, localFirst) {
  if (argv.some(word => /^(?:--no|--no-install|--offline)$/u.test(word))) return []
  const named = packageOptions(argv)
  if (named.length === 0 && argv.some(word => word === '-c' || word === '--call')) return []
  return (named.length > 0 ? named : positional(argv, from).slice(0, 1)).flatMap(text => fetched(tool, npmSpec(text), { localFirst }))
}

const installs = (tool, words, global) => words.flatMap(text => fetched(tool, npmSpec(text), { global }))
const created = (tool, text) => text ? fetched(tool, createPackage(text)) : []
const unlocked = tool => [{ kind: 'unlocked-install', tool }]
const isInstalled = word => /^(?:\.{1,2}(?:\/|$)|file:|link:|workspace:)/u.test(word)

function npm(argv) {
  const words = positional(argv, 1)
  const [command = '', ...rest] = words
  const at = argv.indexOf(command)
  if (command === 'exec' || command === 'x') return execPackages(`npm ${command}`, argv, at + 1, true)
  if (/^(?:create|init|innit)$/u.test(command)) return created(`npm ${command}`, rest[0])
  if (/^(?:i|in|ins|inst|insta|instal|install|isnt|isnta|isntal|isntall|add|it|install-test)$/u.test(command)) {
    const named = rest.filter(word => !isInstalled(word))
    if (argv.some(word => GLOBAL.test(word))) return installs(`npm ${command} -g`, named, true)
    return named.length > 0 ? installs(`npm ${command}`, named, false) : unlocked(`npm ${command}`)
  }
  return /^(?:update|up|upgrade|udpate)$/u.test(command) ? unlocked(`npm ${command}`) : []
}

function pnpm(argv) {
  const [command = '', ...rest] = positional(argv, 1)
  if (command === 'dlx') return execPackages('pnpm dlx', argv, argv.indexOf('dlx') + 1, false)
  if (command === 'create') return created('pnpm create', rest[0])
  const global = argv.some(word => GLOBAL.test(word))
  if (command === 'add' || ((command === 'install' || command === 'i') && rest.length > 0)) return installs(`pnpm ${command}${global ? ' -g' : ''}`, rest.filter(word => !isInstalled(word)), global)
  if ((command === 'install' || command === 'i') && argv.includes('--no-frozen-lockfile')) return unlocked(`pnpm ${command} --no-frozen-lockfile`)
  return /^(?:update|up|upgrade)$/u.test(command) ? unlocked(`pnpm ${command}`) : []
}

function yarn(argv) {
  const [command = '', ...rest] = positional(argv, 1)
  if (command === 'dlx') return execPackages('yarn dlx', argv, argv.indexOf('dlx') + 1, false)
  if (command === 'create') return created('yarn create', rest[0])
  if (command === 'global' && rest[0] === 'add') return installs('yarn global add', rest.slice(1), true)
  if (command === 'add') return installs('yarn add', rest.filter(word => !isInstalled(word)), false)
  const frozen = argv.some(word => /^--(?:frozen-lockfile|immutable)$/u.test(word))
  if ((command === '' || command === 'install') && !frozen) return unlocked(command ? 'yarn install' : 'yarn')
  return /^(?:upgrade|up)$/u.test(command) ? unlocked(`yarn ${command}`) : []
}

function bun(argv) {
  const [command = '', ...rest] = positional(argv, 1)
  if (command === 'x') return execPackages('bun x', argv, argv.indexOf('x') + 1, true)
  if (command === 'create') return created('bun create', rest[0])
  const global = argv.some(word => GLOBAL.test(word))
  if (command === 'add' || ((command === 'install' || command === 'i') && rest.length > 0)) return installs(`bun ${command}${global ? ' -g' : ''}`, rest.filter(word => !isInstalled(word)), global)
  if ((command === 'install' || command === 'i') && !argv.some(word => word === '--frozen-lockfile' || word === '--ci')) return unlocked(`bun ${command}`)
  return command === 'update' ? unlocked('bun update') : []
}

// The tools that run a package (whether one installed first), and the rest.
const EXECS = new Map([['npx', true], ['bunx', true], ['pnpx', false]])
const TOOLS = new Map([['npm', npm], ['pnpm', pnpm], ['yarn', yarn], ['bun', bun]])

// What a command of npm's tools fetches, by the program it runs (`program`,
// its name without a path or `.cmd`): `{ kind: 'package', tool, ecosystem,
// name, spec, exact, registry, localFirst, global? }` each, and `{ kind:
// 'unlocked-install', tool }`; none for any other.
export function npmToolFinds(program, argv) {
  if (EXECS.has(program)) return execPackages(program, argv, 1, EXECS.get(program))
  return TOOLS.get(program)?.(argv) ?? []
}
