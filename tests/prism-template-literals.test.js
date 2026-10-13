// `ui/view/prism-template-literals.js` — where a JavaScript template literal
// ends, by scanning rather than by Prism's regex.
//
// The regex gave up on a `${…}` nesting braces more than two deep: the lit
// templates of a bundle (`@click=${() => { fire(new CustomEvent(n, {
// detail: { … } })) }}`) ended at the wrong brace or not at all, and Prism
// paired the backticks left over the other way round. Compare's diff of a
// pretty-printed bundle showed the result: a template's markup coloured as
// code, and the code after it as a string.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

await import('../ui/prism.js')
const { default: Prism } = await import('prismjs/prism.js')

const text = (token) => (typeof token === 'string' ? token : [token.content].flat().map(text).join(''))

// The outermost template literals Prism found, wherever they sit (a markup
// `<script>` nests its code a few tokens deep).
function templates(code, lang = 'javascript') {
  const found = []
  const walk = (tokens) => {
    for (const token of tokens) {
      if (typeof token === 'string') continue
      if (token.type === 'template-string') found.push(text(token))
      else if (Array.isArray(token.content)) walk(token.content)
    }
  }
  walk(Prism.tokenize(code, Prism.languages[lang]))
  return found
}

// The token types around the first `needle` in `code`, outermost first.
function typesAt(code, needle, lang = 'javascript') {
  const at = code.indexOf(needle)
  assert.ok(at >= 0, `${needle} is not in the code`)
  let offset = 0
  const find = (tokens, path) => {
    for (const token of tokens) {
      const length = text(token).length
      if (at < offset + length) {
        if (typeof token === 'string') return path
        const inner = [...path, token.type]
        return Array.isArray(token.content) ? find(token.content, inner) : inner
      }
      offset += length
    }
    return path
  }
  return find(Prism.tokenize(code, Prism.languages[lang]), [])
}

const nav = `function fn(t, e, n = !1) {
  return x\`<header class="manage-header"><nav class="manage-nav" aria-label="Management pages">\${so
    .filter(([o, , r]) => (r == null || r === e) && (o !== "manage-links" || n))
    .map(
      ([o, r]) =>
        x\`<button type="button" aria-current="\${t === o ? "page" : w}" @click="\${() => {
          document.dispatchEvent(
            new CustomEvent("managed-admin-navigate", {
              detail: { view: o },
              bubbles: !0,
              composed: !0
            })
          );
        }}">\${r}</button>\`
    )}</nav></header>\`;
}
var mn = \`:host{display:flex;padding:0 clamp(1rem,3vw,3rem) 3rem;color:var(--text);\`;
`
const header = nav.slice(nav.indexOf('`<header'), nav.indexOf('`;') + 1)

describe('template literals in JavaScript', () => {
  it('keeps a lit template whose handler nests objects one template, and the code after it code', () => {
    assert.deepEqual(templates(nav), [header, '`:host{display:flex;padding:0 clamp(1rem,3vw,3rem) 3rem;color:var(--text);`'])
    assert.deepEqual(typesAt(nav, 'detail'), ['template-string', 'interpolation', 'template-string', 'interpolation', 'literal-property'])
    assert.deepEqual(typesAt(nav, '</button>'), ['template-string', 'interpolation', 'template-string', 'string'])
    assert.deepEqual(typesAt(nav, '</nav>'), ['template-string', 'string'])
    assert.deepEqual(typesAt(nav, 'var mn'), ['keyword'])
    assert.deepEqual(typesAt(nav, 'display'), ['template-string', 'string'])
  })

  it('counts braces at any depth', () => {
    const code = 'a = `${f({ b: { c: { d: { e: { g } } } } })}`; let h = 1'
    assert.deepEqual(templates(code), ['`${f({ b: { c: { d: { e: { g } } } } })}`'])
    assert.deepEqual(typesAt(code, '}`'), ['template-string', 'interpolation', 'interpolation-punctuation'])
    assert.deepEqual(typesAt(code, 'let'), ['keyword'])
  })

  it('skips a brace or a backtick in a string, a comment or a regex inside ${}', () => {
    const code = 'a = `<${f("}`")}${/[}`]/u.test(x) /* } ` */}${(() => { return /}/ })()}${y // }`\n}>`; let h = 1'
    assert.deepEqual(templates(code), [code.slice(4, code.indexOf(';'))])
    assert.deepEqual(typesAt(code, 'let'), ['keyword'])
  })

  it('reads a slash after an operand as division', () => {
    const code = 'a = `${b / 2}${c[0] / d}${(e) / "}"}`; let h = 1'
    assert.deepEqual(templates(code), [code.slice(4, code.indexOf(';'))])
    assert.deepEqual(typesAt(code, 'let'), ['keyword'])
  })

  it('opens no template at a backtick in a string, a comment or a regex', () => {
    const code = 's.replace(/`/g, "\\\\`") // `\nconst t = \'`\' /* ` */\nlet n = `${1}`'
    assert.deepEqual(templates(code), ['`${1}`'])
    assert.deepEqual(typesAt(code, 'const'), ['keyword'])
  })

  it('takes an escaped ${ as text, and one after an escaped backslash as an interpolation', () => {
    assert.deepEqual(typesAt('`\\${a}`', 'a}'), ['template-string', 'string'])
    assert.deepEqual(typesAt('`\\\\${a}`', 'a}'), ['template-string', 'interpolation'])
  })

  it('runs a template the text never closes to its end', () => {
    assert.deepEqual(templates('a = `b ${c({ d })} e\nlet f = 1'), ['`b ${c({ d })} e\nlet f = 1'])
  })

  it('does the same in TypeScript, JSX, TSX and a markup <script>', () => {
    for (const lang of ['typescript', 'jsx', 'tsx']) {
      assert.deepEqual(templates(nav, lang)[0], header, lang)
      assert.deepEqual(typesAt(nav, 'var mn', lang), ['keyword'], lang)
    }
    assert.deepEqual(templates(`<script>${nav}</script>`, 'markup')[0], header)
  })
})
