// The scripts npm runs as it installs a package (the npm viewer's Overview,
// and Compare's tags on a package.json, bundle-compare-code.js).

// The scripts npm runs installing a package from the registry, in the order
// it runs them; not `prepare`, which runs only for a local or git install.
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall']

// A package's install scripts, `[script, command]`, in the order npm runs
// them: those `scripts` names, and `node-gyp rebuild` where the package has
// a `binding.gyp` at its root (`bindingGyp`) and neither install script of
// its own, as npm runs then.
export function installScripts(scripts, bindingGyp = false) {
  const named = { ...scripts }
  if (!named.preinstall && !named.install && bindingGyp) named.install = 'node-gyp rebuild'
  return INSTALL_SCRIPTS.filter(script => typeof named[script] === 'string').map(script => [script, named[script]])
}

// An npm version's install scripts: those its manifest's `installScripts`
// names, and node-gyp's where `paths`, its files' (a list or a set), have a
// binding.gyp at its root.
export function npmInstallScripts(manifest, paths = []) {
  return installScripts(manifest?.installScripts, Boolean(paths && (paths instanceof Set ? paths.has('binding.gyp') : paths.includes('binding.gyp'))))
}

// A package.json's install scripts, from its text; none where it isn't one,
// or names none.
export function packageJsonInstallScripts(text, bindingGyp = false) {
  let json = null
  try { json = typeof text === 'string' ? JSON.parse(text) : null } catch {}
  const scripts = json && typeof json === 'object' && json.scripts && typeof json.scripts === 'object' ? json.scripts : {}
  return installScripts(scripts, bindingGyp)
}
