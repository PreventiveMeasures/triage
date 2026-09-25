import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// SVG resources imported by components are Lit templates in the JS bundle.
// Top-level SVG entry points (app icons, etc.) remain standalone assets.
export const litSvgAsHtml = {
  name: 'lit-svg-as-html',
  setup(build) {
    build.onResolve({ filter: /\.svg$/ }, (args) => {
      if (!args.importer || !args.importer.endsWith('.js')) return null
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
