import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// SVG resources imported by components are Lit templates in the JS bundle.
// Top-level SVG entry points (app icons, etc.) remain standalone assets; a
// stylesheet that names one (`url('./w95-grain.svg#…')`) means that asset,
// served beside the bundled view.css in dev and in out/, so the reference
// is left as written rather than bundled.
export const litSvgAsHtml = {
  name: 'lit-svg-as-html',
  setup(build) {
    build.onResolve({ filter: /\.svg(?:#.*)?$/ }, (args) => {
      if (args.importer?.endsWith('.css')) return { path: args.path, external: true }
      if (!args.importer?.endsWith('.js') || !args.path.endsWith('.svg')) return null
      return { path: resolve(dirname(args.importer), args.path), namespace: 'lit-svg' }
    })
    build.onLoad({ filter: /.*/, namespace: 'lit-svg' }, async (args) => {
      const source = await readFile(args.path, 'utf8')
      return {
        contents: svgTemplateModule(source),
        loader: 'js', resolveDir: dirname(args.path), watchFiles: [args.path],
      }
    })
  },
}

export function svgTemplateModule(source) {
  const template = source.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${')
  return `import { html } from 'lit'; export default html\`${template}\`;`
}
