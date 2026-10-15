import { html, svg } from 'lit'
import { styleMap } from './style-map.js'
import { langForPath } from '../../common/code-language.js'

const pythonMark = svg`<path d="M8 1C4.5 1 4 1.5 4 3v1h4v1H3C1.5 5 1 6 1 8s.5 3 2 3h1V9c0-1.5 1-2 2.5-2H10c1.5 0 2-.5 2-2V3c0-1.5-.5-2-4-2Z" fill="#3776ab"/><path d="M8 1C4.5 1 4 1.5 4 3v1h4v1H3C1.5 5 1 6 1 8s.5 3 2 3h1V9c0-1.5 1-2 2.5-2H10c1.5 0 2-.5 2-2V3c0-1.5-.5-2-4-2Z" fill="#ffd43b" transform="rotate(180 8 8)"/><circle cx="6" cy="2.8" r=".65" fill="#fff"/><circle cx="10" cy="13.2" r=".65" fill="#fff"/>`

// Rust's: an R in a gear, the gear's middle cut through to whatever it sits on.
const rustMark = svg`<path d="M6.42 2.11 6.81 .49 9.19 .49 9.58 2.11 11.05 2.72 12.47 1.85 14.15 3.53 13.28 4.95 13.89 6.42 15.51 6.81 15.51 9.19 13.89 9.58 13.28 11.05 14.15 12.47 12.47 14.15 11.05 13.28 9.58 13.89 9.19 15.51 6.81 15.51 6.42 13.89 4.95 13.28 3.53 14.15 1.85 12.47 2.72 11.05 2.11 9.58 .49 9.19 .49 6.81 2.11 6.42 2.72 4.95 1.85 3.53 3.53 1.85 4.95 2.72ZM8 3.7a4.3 4.3 0 1 0 0 8.6 4.3 4.3 0 1 0 0 -8.6Z" fill="#c97d5d" fill-rule="evenodd"/><text x="8" y="10.8" text-anchor="middle" fill="currentColor" font-family="serif" font-size="8" font-weight="700">R</text>`
/*!
 * PHP elephant adapted from Material Icon Theme:
 * https://github.com/material-extensions/vscode-material-icon-theme/blob/main/icons/php_elephant.svg
 * Copyright (c) 2025 Material Extensions
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const phpMark = svg`<g fill="#8892bf" transform="translate(0 .5) scale(.5)"><path d="M28 10a4 4 0 0 0-4-4h-6v6a6 6 0 0 1-6 6h-2v2h2v6h4v-6h8v6h4V16h2v-4a2 2 0 0 0-2-2"/><path d="M12 4H8v2a6 6 0 0 0-6 6v6a2 2 0 0 0 2 2v2H2.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5H6a2 2 0 0 0 2-2v-8h4a4 4 0 0 0 4-4V8a4 4 0 0 0-4-4M6 14H4v-2h2Z"/></g>`

// LICENSE, LICENCE, UNLICENSE and COPYING: bare or with a -suffix (LICENSE-MIT),
// then a license's name (LICENSE.BSD, COPYING.LESSER, LICENSE.Apache-2.0), a
// version (LICENSE.2.0) and a prose extension (LICENSE.md, LICENSE-MIT.txt),
// each optional. Any other extension names a file of another kind, whether
// code in a language not mapped here (license.go) or not text (LICENSE.pdf).
const LICENSE_NAME = /^(?:(?:un)?licen[cs]e|copying)(?:-[^/.]*)?(?:\.(?:mit|bsd|isc|apache|[al]?gpl|mpl|epl|eupl|cddl|cc0|zlib|psf|boost|bsl|artistic|unicode|ofl|wtfpl|lesser|lib)(?:v?\d[^/.]*|-[^/.]*)?)?(?:\.\d[^/.]*)*(?:\.(?:md|markdown|txt|text|rst|adoc|asciidoc|org))?$/iu

// Formats of files that are not text: a Stasis resource whose bytes are not
// UTF-8, a Stasis directory capture, and `binary`, which callers pass for an
// npm package's file the server found not to be text.
const NOT_TEXT_FORMATS = new Set(['resource:base64', 'directory', 'binary'])
export const isNotTextFormat = format => NOT_TEXT_FORMATS.has(format)

// A license is told by its name, but only a text one: a recorded format naming
// code or a file that is not text keeps its own icon.
function isLicense(path, format, lang) {
  if ((lang !== null && lang !== 'markdown') || isNotTextFormat(format)) return false
  return LICENSE_NAME.test(path.slice(path.lastIndexOf('/') + 1))
}

// The format a file's icon reads from its bundle's details: the one Stasis
// records, or `binary` for an npm package's file the server found not to be
// text (npm-package.js `npmBinaries`). Every caller holding details asks
// here, so none can forget a file that is not text.
export function fileIconFormat(details, path) {
  return (details?.kind === 'stasis' ? details.bundle?.formats?.get(path) : undefined) ?? (details?.npmBinaries?.has(path) ? 'binary' : undefined)
}

// A path's extension, lowercased, read from its name alone as langForPath does.
const extensionOf = path => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}
// Compiled code a package ships: Node's native addons and the shared
// libraries they load.
const NATIVE = new Set(['node', 'so', 'dylib', 'dll'])

// Source-file icons shared by the repository picker and bundle Code view.
export function sourceFileType(path, format) {
  const lang = langForPath(path, format)
  // A source map before a license: license.js.map is the map of license.js.
  if (lang === null && /\.map$/iu.test(path)) return 'map'
  if (isLicense(path, format, lang)) return 'license'
  if (['javascript', 'jsx'].includes(lang)) return 'js'
  if (['typescript', 'tsx'].includes(lang)) return 'ts'
  const extension = extensionOf(path)
  // A .h is C's, C++'s or Objective-C's alike: a header, whichever reads it.
  if (['c', 'cpp', 'objectivec'].includes(lang) && extension === 'h') return 'header'
  if (['solidity', 'rust', 'php', 'python', 'json', 'markdown', 'css', 'yaml', 'markup', 'java', 'ruby', 'c', 'cpp'].includes(lang)) return lang
  if (lang === 'bash') return 'shell'
  if (lang === 'objectivec') return 'objc'
  if (extension === 'wasm') return 'wasm'
  if (NATIVE.has(extension)) return 'native'
  return 'generic'
}

// A source map's: a map folded in three.
const mapMark = svg`<path d="M1.5 3.4 5.3 2l5.4 1.6 3.8-1.4v10.4l-3.8 1.4-5.4-1.6-3.8 1.4Z" fill="#3fa59a" fill-opacity=".22" stroke="#3fa59a" stroke-width="1.1" stroke-linejoin="round"/><path d="M5.3 2v10.4m5.4-8.8V14" stroke="#3fa59a" stroke-width="1.1"/>`

// A license's: the scales of justice.
const licenseMark = svg`<circle cx="8" cy="2.6" r="1" fill="currentColor"/><path d="M8 3.6v9.9m-3.5 0h7M3 4.6h10M3 4.6 1.2 9.2M3 4.6l1.8 4.6M13 4.6l-1.8 4.6M13 4.6l1.8 4.6" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 9.2h4a2 2 0 0 1-4 0Zm10 0h4a2 2 0 0 1-4 0Z" fill="currentColor"/>`

// CSS's: the language's own logo, CSS in the corner of a rebeccapurple square.
const cssMark = svg`<rect x="1" y="1" width="14" height="14" rx="2" fill="#663399"/><text x="14" y="13.2" text-anchor="end" fill="#fff" font-family="sans-serif" font-size="6.4" font-weight="700" letter-spacing="-.2">CSS</text>`

// Markdown's: the M and its down arrow, unframed, in the theme's green.
const markdownMark = svg`<path d="M1 11.5v-7h2l1.7 2.3 1.7-2.3h2v7h-2V7.8L4.7 10 3 7.8v3.7Zm10.2-7h2V8H15l-2.8 3.5L9.4 8h1.8Z" fill="var(--green, #3fb950)"/>`

// A language's letters on a square of its colour, as JS's and TS's logos are
// drawn; three letters set smaller.
const badge = (fill, label, ink = '#fff') => label.length > 2
  ? svg`<rect x="1" y="1" width="14" height="14" rx="2" fill=${fill}/><text x="8" y="10.6" text-anchor="middle" fill=${ink} font-family="sans-serif" font-size="6.2" font-weight="700" letter-spacing="-.2">${label}</text>`
  : svg`<rect x="1" y="1" width="14" height="14" rx="2" fill=${fill}/><text x="8" y="11.5" text-anchor="middle" fill=${ink} font-family="sans-serif" font-size="8" font-weight="700">${label}</text>`

// Each type's glyph (sourceFileType); any other a page.
const MARKS = {
  __proto__: null,
  js: badge('#e6c84f', 'JS', '#202020'),
  ts: badge('#3178c6', 'TS'),
  solidity: svg`<path d="m8 1 4 6-4 2-4-2Z" fill="currentColor"/><path d="m4 8 4 2 4-2-4 7Z" fill="currentColor" opacity=".65"/>`,
  rust: rustMark,
  php: phpMark,
  python: pythonMark,
  map: mapMark,
  markdown: markdownMark,
  license: licenseMark,
  css: cssMark,
  // JSON's: its braces, a shape apart from JavaScript's square, in amber: a
  // bright one on dark themes, a deeper one on light themes that holds 3:1 on
  // their pale surfaces, a hovered row's too.
  json: svg`<path d="M6 2.5C4.6 2.5 4.4 3.3 4.4 4.6v1.6C4.4 7.4 3.8 8 2.6 8c1.2 0 1.8.6 1.8 1.8v1.6c0 1.3.2 2.1 1.6 2.1M10 2.5c1.4 0 1.6.8 1.6 2.1v1.6c0 1.2.6 1.8 1.8 1.8-1.2 0-1.8.6-1.8 1.8v1.6c0 1.3-.2 2.1-1.6 2.1" fill="none" stroke="light-dark(#a26e12, #f2b440)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  yaml: badge('#cb171e', 'YML'),
  // A shell's: a terminal's prompt.
  shell: svg`<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="m4.2 6 2 2-2 2m3.3 0h4.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  // HTML's, XML's and SVG's: a tag's brackets, in HTML's orange.
  markup: svg`<path d="M4.8 4.5 1.5 8l3.3 3.5m6.4-7L14.5 8l-3.3 3.5M9.3 3 6.7 13" fill="none" stroke="#e34c26" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  wasm: badge('#654ff0', 'WA'),
  // Native code's: a chip.
  native: svg`<rect x="4" y="4" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/><rect x="6.4" y="6.4" width="3.2" height="3.2" fill="currentColor"/><path d="M6 1.5V4m4-2.5V4M6 12v2.5m4-2.5v2.5M1.5 6H4m-2.5 4H4M12 6h2.5M12 10h2.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>`,
  // Java's: its cup, steaming.
  java: svg`<path d="M5.4 5.8c-.9-1 .9-1.7 0-3M8.4 5.8c-.9-1 .9-1.7 0-3" fill="none" stroke="#e76f00" stroke-width="1.1" stroke-linecap="round"/><path d="M2.5 7h9v3.3A3.7 3.7 0 0 1 7.8 14H6.2a3.7 3.7 0 0 1-3.7-3.7Z" fill="#5382a1"/><path d="M11.5 8.2h.9a1.6 1.6 0 0 1 0 3.2h-1.1" fill="none" stroke="#5382a1" stroke-width="1.1"/>`,
  objc: badge('#438eff', 'OC'),
  c: badge('#3949ab', 'C'),
  cpp: badge('#00599c', 'C++'),
  header: badge('#607d8b', 'H'),
  // Ruby's: a cut gem, Podfiles, podspecs and Fastfiles too.
  ruby: svg`<path d="M4.5 2.5h7L14.5 6 8 14 1.5 6Z" fill="#cc342d"/><path d="M1.5 6h13M4.5 2.5 6 6l2 8 2-8 1.5-3.5M6 6l2-3.5L10 6" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width=".7" stroke-linejoin="round"/>`,
}
const pageMark = svg`<path d="M4 1.5h5l3 3v10H4Zm5 0v3h3M6 8h4M6 10.5h4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>`

export function sourceFileIcon(path, format) {
  const type = sourceFileType(path, format)
  return html`<svg class="source-file-icon" data-file-type=${type} width="16" height="16" viewBox="0 0 16 16" style=${styleMap({ flex: 'none' })} aria-hidden="true">${MARKS[type] ?? pageMark}</svg>`
}

export const sourceFolderIcon = html`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" style=${styleMap({ flex: 'none' })} aria-hidden="true"><path d="M1.5 4V2.5h5L8 4h6.5v9h-13Z" stroke-linejoin="round"/></svg>`

export const sourceNpmIcon = html`<svg class="bundle-code-tree-npm" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M1 1h14v14H1Zm3 3v8h4V6h2v6h2V4Z"/></svg>`

const sourceSoldeerIcon = html`<svg class="bundle-code-tree-soldeer" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
  <path d="m8 1 6 3.5v7L8 15l-6-3.5v-7Z" fill="none" stroke="currentColor" stroke-width="1"/>
  <path d="m8 3 2.5 4L8 8.5 5.5 7Zm-2.5 5L8 9.5 10.5 8 8 13Z" fill="currentColor"/>
</svg>`

const sourceComposerIcon = html`<svg class="bundle-code-tree-composer" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
  <path d="M8 1 15 4.5v7L8 15l-7-3.5v-7Z" fill="#8892bf"/>
  <path d="m1 4.5 7 3.5 7-3.5M8 8v7M4.5 2.75l7 3.5" fill="none" stroke="var(--surface, #fff)" stroke-width=".9"/>
</svg>`

// Front-center Cargo box, adapted from https://www.svgrepo.com/svg/373489/cargo (CC0).
const sourceCargoIcon = html`<svg class="bundle-code-tree-cargo" width="12" height="12" viewBox="9.25 6.14 14 14" aria-hidden="true">
  <path d="m16.264 11.547 6.2-2.446v8.16l-6.2 2.485Zm0-.019-6.2-2.481v8.123l6.2 2.522Z" fill="#e5ac3d" stroke="#73561f" stroke-miterlimit="10" stroke-width=".05430921534373718px"/>
  <path d="m16.277 11.508 6.169-2.435-6.2-2.531-6.2 2.467Z" fill="#e3b04e" stroke="#73561f" stroke-miterlimit="10" stroke-width=".05430921534373718px"/>
  <path d="m12.82 10.149 6.196-2.467" fill="none" stroke="#73561f" stroke-miterlimit="10" stroke-width=".05430921534373718px"/>
  <path d="m18.301 7.395-6.24 2.484 1.482.593 6.196-2.466z" fill="#fff" stroke="#73561f" stroke-miterlimit="10" stroke-width=".04741218643894885px" opacity=".3"/>
  <path d="m13.562 10.47-1.453-.565v1.645l.201-.136.18.285.104.04.138-.121.137.228.129.05.189-.166.238.332.137.053zm-1.423 7.576 1.461.545-.023-1.645-.2.139-.184-.282-.104-.039-.136.123-.14-.226-.131-.049-.186.169-.243-.329-.137-.051z" fill="#fff" stroke="#73561f" stroke-miterlimit="10" stroke-width=".06661495224335688px" opacity=".3"/>
  <path d="m21.426 13.49-.172-.039V13.4l.148-.208a.1.1 0 0 0 .018-.065.035.035 0 0 0-.037-.03l-.189.006-.015-.045.118-.222a.07.07 0 0 0 .007-.063.04.04 0 0 0-.045-.018l-.2.051-.024-.037.084-.229a.06.06 0 0 0 0-.058.04.04 0 0 0-.051-.006l-.2.094-.032-.027.047-.227a.05.05 0 0 0-.016-.052.05.05 0 0 0-.056.007l-.2.133-.039-.017.007-.215a.04.04 0 0 0-.026-.043.07.07 0 0 0-.058.02l-.184.166-.045-.006-.033-.2a.036.036 0 0 0-.036-.032.08.08 0 0 0-.057.031l-.164.194-.049.005-.071-.168a.036.036 0 0 0-.044-.021.1.1 0 0 0-.055.042l-.138.214-.05.016-.107-.135a.04.04 0 0 0-.05-.008.1.1 0 0 0-.05.051l-.107.226-.05.026-.138-.1a.05.05 0 0 0-.055 0 .1.1 0 0 0-.044.058l-.071.228-.049.036-.164-.054a.06.06 0 0 0-.057.017.1.1 0 0 0-.036.063l-.033.223-.045.044-.184-.01a.08.08 0 0 0-.058.029.1.1 0 0 0-.026.065l.007.209-.039.05-.2.035a.1.1 0 0 0-.056.04.1.1 0 0 0-.016.065l.046.187-.032.054-.2.079a.1.1 0 0 0-.051.049.07.07 0 0 0 0 .062l.084.157-.024.057-.2.119a.1.1 0 0 0-.045.057.06.06 0 0 0 .007.057l.118.122-.015.058-.189.155a.1.1 0 0 0-.037.062.045.045 0 0 0 .018.05l.148.082v.055l-.172.185a.1.1 0 0 0-.028.065.04.04 0 0 0 .028.041l.172.039v.051l-.148.208a.1.1 0 0 0-.018.065.035.035 0 0 0 .037.03l.189-.006.015.045-.118.222a.07.07 0 0 0-.007.063.04.04 0 0 0 .045.018l.2-.051.024.037-.084.229a.06.06 0 0 0 0 .058.04.04 0 0 0 .051.006l.2-.094.032.027-.046.227a.05.05 0 0 0 .016.051.05.05 0 0 0 .056-.007l.2-.133.039.017-.007.215a.04.04 0 0 0 .026.043.07.07 0 0 0 .058-.02l.184-.166.045.006.033.2a.035.035 0 0 0 .036.032.08.08 0 0 0 .057-.031l.164-.194.049-.005.071.168a.036.036 0 0 0 .044.02.1.1 0 0 0 .055-.042l.138-.214.05-.016.107.135a.04.04 0 0 0 .05.008.1.1 0 0 0 .05-.051l.107-.226.05-.027.138.1a.05.05 0 0 0 .055 0 .1.1 0 0 0 .044-.058l.071-.228.049-.036.164.054a.06.06 0 0 0 .057-.017.1.1 0 0 0 .036-.063l.033-.223.045-.044.184.01a.08.08 0 0 0 .058-.029.1.1 0 0 0 .026-.065l-.007-.209.039-.05.2-.035a.1.1 0 0 0 .056-.04.1.1 0 0 0 .016-.065l-.046-.187.017-.053.2-.079a.1.1 0 0 0 .051-.049.07.07 0 0 0 0-.062l-.084-.157.024-.057.2-.119a.1.1 0 0 0 .045-.057.06.06 0 0 0-.007-.057l-.118-.122.015-.058.189-.155a.1.1 0 0 0 .037-.062.045.045 0 0 0-.018-.05l-.148-.082v-.055l.172-.185a.1.1 0 0 0 .028-.065.04.04 0 0 0-.014-.039m-1.153 1.988c-.066.013-.108-.037-.094-.112a.21.21 0 0 1 .145-.16c.066-.013.108.037.094.112a.21.21 0 0 1-.145.16m-.059-.39a.19.19 0 0 0-.132.146l-.061.325a2.3 2.3 0 0 1-.619.4 1.4 1.4 0 0 1-.632.123l-.061-.273c-.013-.057-.072-.072-.132-.033l-.252.164a1 1 0 0 1-.13-.106l1.226-.521q.022-.007.023-.026v-.455c0-.013-.009-.012-.023-.006l-.359.152v-.288l.388-.165a.16.16 0 0 1 .239.115c.015.057.049.249.072.3s.117.172.217.13l.611-.26.022-.012a3 3 0 0 1-.139.23Zm-1.7 1.13c-.066.043-.131.026-.145-.037a.2.2 0 0 1 .094-.192c.066-.043.131-.026.145.037a.2.2 0 0 1-.09.192Zm-.465-1.779a.18.18 0 0 1-.062.2c-.062.055-.134.056-.161 0a.18.18 0 0 1 .062-.2c.066-.051.138-.053.165 0Zm-.143.416.263-.234a.16.16 0 0 0 .057-.178l-.054-.105.213-.09v1l-.429.182a1.4 1.4 0 0 1-.057-.407c.001-.052.001-.11.011-.168Zm1.152-.587v-.3l.506-.215c.026-.011.185-.047.185.077 0 .1-.122.192-.222.234l-.47.2Zm1.84-.516v.118l-.154.065a.04.04 0 0 0-.022.036v.074a.31.31 0 0 1-.176.3c-.078.043-.165.036-.176-.01-.046-.253-.123-.278-.245-.327a1 1 0 0 0 .308-.578.3.3 0 0 0-.235-.315.57.57 0 0 0-.322.026l-1.592.677a2.7 2.7 0 0 1 .84-.853l.188.127c.042.029.113 0 .157-.063l.21-.3a.94.94 0 0 1 1.027.33l-.144.4c-.025.069 0 .128.057.13l.277.011q.004.073.004.152Zm-1.591-1.044c.049-.069.126-.1.172-.069s.045.113 0 .183-.126.1-.172.069-.044-.114.005-.184Zm1.427.6a.19.19 0 0 1 .161-.133c.062 0 .089.066.062.142a.19.19 0 0 1-.161.133c-.057-.006-.085-.07-.058-.15Z" opacity=".55"/>
  <path d="M0 16.309h22.926v9.971L45.72 13.139 22.926 0v9.97H0z" fill="#231f20" transform="matrix(0 -.029 .022 .013 10.451 11.138)"/>
  <path d="M0 16.309h22.926v9.971L45.72 13.139 22.926 0v9.97H0z" fill="#231f20" transform="matrix(0 -.029 .022 .013 15.013 12.984)"/>
</svg>`

// A package's icon in the Code views' trees, by its ecosystem.
export function sourcePackageIcon(ecosystem) {
  return ecosystem === 'composer' ? sourceComposerIcon : ecosystem === 'cargo' ? sourceCargoIcon : ecosystem === 'soldeer' ? sourceSoldeerIcon : sourceNpmIcon
}
