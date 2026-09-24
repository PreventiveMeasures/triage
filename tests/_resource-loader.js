// Component tests import the same SVG and CSS resources as the browser build.
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { svgTemplateModule } from '../build-lit-svg.js'

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
