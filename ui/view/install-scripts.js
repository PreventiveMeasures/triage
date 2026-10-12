// The scripts npm runs as it installs a package (the npm viewer's Overview,
// and Compare's tags on a package.json, bundle-compare-code.js).

// The install scripts, in the order npm runs them.
export const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

// A package's install scripts, `[script, command]`, in the order npm runs
// them: those `scripts` names, and `node-gyp rebuild` where the package has
// a `binding.gyp` at its root (`bindingGyp`) and neither install script of
// its own, as npm runs then.
export function installScripts(scripts, bindingGyp = false) {
  const named = { ...scripts }
  if (!named.preinstall && !named.install && bindingGyp) named.install = 'node-gyp rebuild'
  return INSTALL_SCRIPTS.filter(script => typeof named[script] === 'string').map(script => [script, named[script]])
}

// A package.json's install scripts, from its text; none where it isn't one,
// or names none.
export function packageJsonInstallScripts(text, bindingGyp = false) {
  let json = null
  try { json = typeof text === 'string' ? JSON.parse(text) : null } catch {}
  const scripts = json && typeof json === 'object' && json.scripts && typeof json.scripts === 'object' ? json.scripts : {}
  return installScripts(scripts, bindingGyp)
}
