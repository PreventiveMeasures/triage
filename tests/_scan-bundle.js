// Scans' own bundle, ui/scan.js, holds the shared scan page and the local
// host's `<local-scan-page>`. Manage's Scans page loads it through
// view/lazy-entry.js by a runtime string, which the browser resolves beside the
// bundle. Manage needs only the shared page, and the local host's element
// imports view.js's modules, so resolve that import to ui/scan/page.js here,
// loaded up front so its elements are defined for the tests.
import { registerHooks } from 'node:module'

const loader = new URL('../ui/view/lazy-entry.js', import.meta.url).href
const page = new URL('../ui/scan/page.js', import.meta.url).href
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier !== './scan.js' || context.parentURL !== loader) return nextResolve(specifier, context)
  return { shortCircuit: true, url: page }
} })
await import(page)
