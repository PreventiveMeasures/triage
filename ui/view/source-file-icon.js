import { html, svg } from 'lit'
import { langForPath } from '../../common/code-language.js'

const pythonMark = svg`<path d="M8 1C4.5 1 4 1.5 4 3v1h4v1H3C1.5 5 1 6 1 8s.5 3 2 3h1V9c0-1.5 1-2 2.5-2H10c1.5 0 2-.5 2-2V3c0-1.5-.5-2-4-2Z" fill="#3776ab"/><path d="M8 1C4.5 1 4 1.5 4 3v1h4v1H3C1.5 5 1 6 1 8s.5 3 2 3h1V9c0-1.5 1-2 2.5-2H10c1.5 0 2-.5 2-2V3c0-1.5-.5-2-4-2Z" fill="#ffd43b" transform="rotate(180 8 8)"/><circle cx="6" cy="2.8" r=".65" fill="#fff"/><circle cx="10" cy="13.2" r=".65" fill="#fff"/>`

const rustMark = svg`<path d="m7 0 2 0 .4 1.6 1.3.5 1.4-.9 1.4 1.4-.9 1.4.5 1.3 1.6.4v2l-1.6.4-.5 1.3.9 1.4-1.4 1.4-1.4-.9-1.3.5-.4 1.6H7l-.4-1.6-1.3-.5-1.4.9-1.4-1.4.9-1.4-.5-1.3L1.3 9V7l1.6-.4.5-1.3-.9-1.4 1.4-1.4 1.4.9 1.3-.5Z" fill="#c97d5d"/><circle cx="8" cy="8" r="4.4" fill="var(--surface, #fff)"/><text x="8" y="10.8" text-anchor="middle" fill="currentColor" font-family="serif" font-size="8" font-weight="700">R</text>`
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

// Source-file icons shared by the repository picker and bundle Code view.
export function sourceFileType(path, format) {
  const lang = langForPath(path, format)
  if (['javascript', 'jsx'].includes(lang)) return 'js'
  if (['typescript', 'tsx'].includes(lang)) return 'ts'
  if (['solidity', 'rust', 'php', 'python', 'json'].includes(lang)) return lang
  return 'generic'
}

export function sourceFileIcon(path, format) {
  const type = sourceFileType(path, format)
  const mark = type === 'js' || type === 'ts'
    ? svg`<rect x="1" y="1" width="14" height="14" rx="2" fill=${type === 'js' ? '#e6c84f' : '#3178c6'}/><text x="8" y="11.5" text-anchor="middle" fill=${type === 'js' ? '#202020' : '#fff'} font-family="sans-serif" font-size="8" font-weight="700">${type.toUpperCase()}</text>`
    : type === 'solidity'
      ? svg`<path d="m8 1 4 6-4 2-4-2Z" fill="currentColor"/><path d="m4 8 4 2 4-2-4 7Z" fill="currentColor" opacity=".65"/>`
      : type === 'rust'
        ? rustMark
        : type === 'php'
          ? phpMark
          : type === 'python'
            ? pythonMark
            : type === 'json'
              ? svg`<path d="M3 1h6l5 5v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Z" fill="#e6c84f"/><path d="M9 1v4a1 1 0 0 0 1 1h4Z" fill="#202020" opacity=".2"/><path d="M6.5 6.5h-.75a.75.75 0 0 0-.75.75v1.5L4 9.5l1 .75v1.5a.75.75 0 0 0 .75.75h.75m3-6h.75a.75.75 0 0 1 .75.75v1.5l1 .75-1 .75v1.5a.75.75 0 0 1-.75.75H9.5" fill="none" stroke="#202020" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>`
              : svg`<path d="M4 1.5h5l3 3v10H4Zm5 0v3h3M6 8h4M6 10.5h4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>`
  return html`<svg class="source-file-icon" data-file-type=${type} width="16" height="16" viewBox="0 0 16 16" style="flex: none" aria-hidden="true">${mark}</svg>`
}

export const sourceFolderIcon = html`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" style="flex: none" aria-hidden="true"><path d="M1.5 4V2.5h5L8 4h6.5v9h-13Z" stroke-linejoin="round"/></svg>`

export const sourceNpmIcon = html`<svg class="bundle-code-tree-npm" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M1 1h14v14H1Zm3 3v8h4V6h2v6h2V4Z"/></svg>`

export const sourceSoldeerIcon = html`<svg class="bundle-code-tree-soldeer" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
  <path d="m8 1 6 3.5v7L8 15l-6-3.5v-7Z" fill="none" stroke="currentColor" stroke-width="1"/>
  <path d="m8 3 2.5 4L8 8.5 5.5 7Zm-2.5 5L8 9.5 10.5 8 8 13Z" fill="currentColor"/>
</svg>`

export const sourceComposerIcon = html`<svg class="bundle-code-tree-composer" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
  <path d="M8 1 15 4.5v7L8 15l-7-3.5v-7Z" fill="#8892bf"/>
  <path d="m1 4.5 7 3.5 7-3.5M8 8v7M4.5 2.75l7 3.5" fill="none" stroke="var(--surface, #fff)" stroke-width=".9"/>
</svg>`

// Front-center Cargo box, adapted from https://www.svgrepo.com/svg/373489/cargo (CC0).
export const sourceCargoIcon = html`<svg class="bundle-code-tree-cargo" width="12" height="12" viewBox="9.25 6.14 14 14" aria-hidden="true">
  <path d="m16.264 11.547 6.2-2.446v8.16l-6.2 2.485Zm0-.019-6.2-2.481v8.123l6.2 2.522Z" fill="#e5ac3d" stroke="#73561f" stroke-miterlimit="10" stroke-width=".05430921534373718px"/>
  <path d="m16.277 11.508 6.169-2.435-6.2-2.531-6.2 2.467Z" fill="#e3b04e" stroke="#73561f" stroke-miterlimit="10" stroke-width=".05430921534373718px"/>
  <path d="m12.82 10.149 6.196-2.467" fill="none" stroke="#73561f" stroke-miterlimit="10" stroke-width=".05430921534373718px"/>
  <path d="m18.301 7.395-6.24 2.484 1.482.593 6.196-2.466z" fill="#fff" stroke="#73561f" stroke-miterlimit="10" stroke-width=".04741218643894885px" opacity=".3"/>
  <path d="m13.562 10.47-1.453-.565v1.645l.201-.136.18.285.104.04.138-.121.137.228.129.05.189-.166.238.332.137.053zm-1.423 7.576 1.461.545-.023-1.645-.2.139-.184-.282-.104-.039-.136.123-.14-.226-.131-.049-.186.169-.243-.329-.137-.051z" fill="#fff" stroke="#73561f" stroke-miterlimit="10" stroke-width=".06661495224335688px" opacity=".3"/>
  <path d="m21.426 13.49-.172-.039V13.4l.148-.208a.1.1 0 0 0 .018-.065.035.035 0 0 0-.037-.03l-.189.006-.015-.045.118-.222a.07.07 0 0 0 .007-.063.04.04 0 0 0-.045-.018l-.2.051-.024-.037.084-.229a.06.06 0 0 0 0-.058.04.04 0 0 0-.051-.006l-.2.094-.032-.027.047-.227a.05.05 0 0 0-.016-.052.05.05 0 0 0-.056.007l-.2.133-.039-.017.007-.215a.04.04 0 0 0-.026-.043.07.07 0 0 0-.058.02l-.184.166-.045-.006-.033-.2a.036.036 0 0 0-.036-.032.08.08 0 0 0-.057.031l-.164.194-.049.005-.071-.168a.036.036 0 0 0-.044-.021.1.1 0 0 0-.055.042l-.138.214-.05.016-.107-.135a.04.04 0 0 0-.05-.008.1.1 0 0 0-.05.051l-.107.226-.05.026-.138-.1a.05.05 0 0 0-.055 0 .1.1 0 0 0-.044.058l-.071.228-.049.036-.164-.054a.06.06 0 0 0-.057.017.1.1 0 0 0-.036.063l-.033.223-.045.044-.184-.01a.08.08 0 0 0-.058.029.1.1 0 0 0-.026.065l.007.209-.039.05-.2.035a.1.1 0 0 0-.056.04.1.1 0 0 0-.016.065l.046.187-.032.054-.2.079a.1.1 0 0 0-.051.049.07.07 0 0 0 0 .062l.084.157-.024.057-.2.119a.1.1 0 0 0-.045.057.06.06 0 0 0 .007.057l.118.122-.015.058-.189.155a.1.1 0 0 0-.037.062.045.045 0 0 0 .018.05l.148.082v.055l-.172.185a.1.1 0 0 0-.028.065.04.04 0 0 0 .028.041l.172.039v.051l-.148.208a.1.1 0 0 0-.018.065.035.035 0 0 0 .037.03l.189-.006.015.045-.118.222a.07.07 0 0 0-.007.063.04.04 0 0 0 .045.018l.2-.051.024.037-.084.229a.06.06 0 0 0 0 .058.04.04 0 0 0 .051.006l.2-.094.032.027-.046.227a.05.05 0 0 0 .016.051.05.05 0 0 0 .056-.007l.2-.133.039.017-.007.215a.04.04 0 0 0 .026.043.07.07 0 0 0 .058-.02l.184-.166.045.006.033.2a.035.035 0 0 0 .036.032.08.08 0 0 0 .057-.031l.164-.194.049-.005.071.168a.036.036 0 0 0 .044.02.1.1 0 0 0 .055-.042l.138-.214.05-.016.107.135a.04.04 0 0 0 .05.008.1.1 0 0 0 .05-.051l.107-.226.05-.027.138.1a.05.05 0 0 0 .055 0 .1.1 0 0 0 .044-.058l.071-.228.049-.036.164.054a.06.06 0 0 0 .057-.017.1.1 0 0 0 .036-.063l.033-.223.045-.044.184.01a.08.08 0 0 0 .058-.029.1.1 0 0 0 .026-.065l-.007-.209.039-.05.2-.035a.1.1 0 0 0 .056-.04.1.1 0 0 0 .016-.065l-.046-.187.017-.053.2-.079a.1.1 0 0 0 .051-.049.07.07 0 0 0 0-.062l-.084-.157.024-.057.2-.119a.1.1 0 0 0 .045-.057.06.06 0 0 0-.007-.057l-.118-.122.015-.058.189-.155a.1.1 0 0 0 .037-.062.045.045 0 0 0-.018-.05l-.148-.082v-.055l.172-.185a.1.1 0 0 0 .028-.065.04.04 0 0 0-.014-.039m-1.153 1.988c-.066.013-.108-.037-.094-.112a.21.21 0 0 1 .145-.16c.066-.013.108.037.094.112a.21.21 0 0 1-.145.16m-.059-.39a.19.19 0 0 0-.132.146l-.061.325a2.3 2.3 0 0 1-.619.4 1.4 1.4 0 0 1-.632.123l-.061-.273c-.013-.057-.072-.072-.132-.033l-.252.164a1 1 0 0 1-.13-.106l1.226-.521q.022-.007.023-.026v-.455c0-.013-.009-.012-.023-.006l-.359.152v-.288l.388-.165a.16.16 0 0 1 .239.115c.015.057.049.249.072.3s.117.172.217.13l.611-.26.022-.012a3 3 0 0 1-.139.23Zm-1.7 1.13c-.066.043-.131.026-.145-.037a.2.2 0 0 1 .094-.192c.066-.043.131-.026.145.037a.2.2 0 0 1-.09.192Zm-.465-1.779a.18.18 0 0 1-.062.2c-.062.055-.134.056-.161 0a.18.18 0 0 1 .062-.2c.066-.051.138-.053.165 0Zm-.143.416.263-.234a.16.16 0 0 0 .057-.178l-.054-.105.213-.09v1l-.429.182a1.4 1.4 0 0 1-.057-.407c.001-.052.001-.11.011-.168Zm1.152-.587v-.3l.506-.215c.026-.011.185-.047.185.077 0 .1-.122.192-.222.234l-.47.2Zm1.84-.516v.118l-.154.065a.04.04 0 0 0-.022.036v.074a.31.31 0 0 1-.176.3c-.078.043-.165.036-.176-.01-.046-.253-.123-.278-.245-.327a1 1 0 0 0 .308-.578.3.3 0 0 0-.235-.315.57.57 0 0 0-.322.026l-1.592.677a2.7 2.7 0 0 1 .84-.853l.188.127c.042.029.113 0 .157-.063l.21-.3a.94.94 0 0 1 1.027.33l-.144.4c-.025.069 0 .128.057.13l.277.011q.004.073.004.152Zm-1.591-1.044c.049-.069.126-.1.172-.069s.045.113 0 .183-.126.1-.172.069-.044-.114.005-.184Zm1.427.6a.19.19 0 0 1 .161-.133c.062 0 .089.066.062.142a.19.19 0 0 1-.161.133c-.057-.006-.085-.07-.058-.15Z" opacity=".55"/>
  <path d="M0 16.309h22.926v9.971L45.72 13.139 22.926 0v9.97H0z" fill="#231f20" transform="matrix(0 -.029 .022 .013 10.451 11.138)"/>
  <path d="M0 16.309h22.926v9.971L45.72 13.139 22.926 0v9.97H0z" fill="#231f20" transform="matrix(0 -.029 .022 .013 15.013 12.984)"/>
</svg>`
