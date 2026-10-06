// Component tests import the same SVG and CSS resources as the browser build.
import { readFileSync } from 'node:fs'
import { enableCompileCache, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { svgTemplateModule } from '../build-lit-svg.js'

// Test files and spawned servers repeatedly load the same module graphs. Share
// their compiled code while keeping each test file in its own process. Coverage
// runs need fresh compilation for precise V8 coverage; the Node disable flag
// and an explicitly configured cache directory are also respected.
if (!process.env.NODE_V8_COVERAGE && !process.execArgv.includes('--experimental-test-coverage')) {
  const baseDirectory = resolve(process.env.NODE_COMPILE_CACHE || join(tmpdir(), 'node-compile-cache'))
  const { directory } = enableCompileCache(baseDirectory)
  // An already-enabled cache reports its versioned directory. Children need the
  // original base so Node does not append another version directory on startup.
  if (directory) process.env.NODE_COMPILE_CACHE = baseDirectory
}

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && /\.(?:svg|css)$/u.test(url)) {
      const content = readFileSync(new URL(url), 'utf8')
      return { format: 'module', shortCircuit: true, source: url.endsWith('.svg')
        ? svgTemplateModule(content) : `export default ${JSON.stringify(content)}` }
    }
    return nextLoad(url, context)
  },
})
