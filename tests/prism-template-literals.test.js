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

// Tokens as `ui/prism.js` gets them: Prism's tokenize between its hooks.
function tokenize(code, lang) {
  const env = { code, grammar: Prism.languages[lang], language: lang }
  Prism.hooks.run('before-tokenize', env)
  env.tokens = Prism.tokenize(env.code, env.grammar)
  Prism.hooks.run('after-tokenize', env)
  return env.tokens
}

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
  walk(tokenize(code, lang))
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
  return find(tokenize(code, lang), [])
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

  it('reads a slash as division where a regex from it would run on into a template', () => {
    // After a regex or a postfix `++` / `--` a slash divides, and a regex
    // ending at the `/` past the `}` would swallow the brace.
    const code = 'a = `${/b/ / 2}/${c}` + `${d++ / 2}/${e}` + `${f-- / 2}/${g}`; let h = 1'
    assert.deepEqual(templates(code), ['`${/b/ / 2}/${c}`', '`${d++ / 2}/${e}`', '`${f-- / 2}/${g}`'])
    assert.deepEqual(typesAt(code, 'let'), ['keyword'])
  })

  it('reads a regex an operator follows as one', () => {
    const code = 'a = `${/`/ && b}` + `${/`/u ? c : d}` + `${/`/ instanceof RegExp}`; let h = 1'
    assert.deepEqual(templates(code), ['`${/`/ && b}`', '`${/`/u ? c : d}`', '`${/`/ instanceof RegExp}`'])
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

  it('reads a regex compared, and a JSX tag\'s </ as no regex', () => {
    const code = 'a = `${/`/ < b}` + `${/`/ > c}`; let h = 1'
    assert.deepEqual(templates(code), ['`${/`/ < b}`', '`${/`/ > c}`'])
    assert.deepEqual(typesAt(code, 'let'), ['keyword'])
    const jsx = 'const e = <p>{`a`}</p>; const g = <div><br/>{`b ${c}`}<i>x</i></div>; let s = `d`'
    assert.deepEqual(templates(jsx, 'jsx'), ['`a`', '`b ${c}`', '`d`'])
    const fragment = 'const e = <><A.B>{`a`}</A.B>{`b`}</ >{`c`}</>; let s = `d`'
    for (const lang of ['jsx', 'tsx']) assert.deepEqual(templates(fragment, lang), ['`a`', '`b`', '`c`', '`d`'], lang)
    // A tag's name is any identifier. Read as a regex, its slash would run on
    // to the one past the template, and Prism's own pattern, taking over,
    // ends the template at the backtick of the one nested in it.
    const unicode = 'const t = `${f({a:{b:{c:{d:<组件></组件>}}}}, `x`)}` /foo; let h = 1'
    for (const lang of ['jsx', 'tsx']) {
      assert.deepEqual(templates(unicode, lang), ['`${f({a:{b:{c:{d:<组件></组件>}}}}, `x`)}`'], lang)
      assert.deepEqual(typesAt(unicode, '}`', lang), ['template-string', 'interpolation', 'interpolation-punctuation'], lang)
    }
    // Minified code compares with a regex's result, and no tag follows; the
    // braces are deeper than Prism's own pattern reads, so only the scan can
    // end the `${…}` at its last `}`.
    const minified = 'a = `${i</`/.exec(s).index+f({b:{c:{d}}})}`; let h = 1'
    assert.deepEqual(templates(minified), ['`${i</`/.exec(s).index+f({b:{c:{d}}})}`'])
    assert.deepEqual(typesAt(minified, '}`'), ['template-string', 'interpolation', 'interpolation-punctuation'])
    assert.deepEqual(typesAt(minified, 'let'), ['keyword'])
    // Without JSX, even a regex that opens like a tag is one.
    for (const lang of ['javascript', 'typescript']) {
      const tagLike = 'a = `${x</p>[}]/u.test(s)+f({b:{c:{d}}})}`; let h = 1'
      assert.deepEqual(templates(tagLike, lang), [tagLike.slice(4, tagLike.indexOf(';'))], lang)
      assert.deepEqual(typesAt(tagLike, '}`', lang), ['template-string', 'interpolation', 'interpolation-punctuation'], lang)
    }
  })

  it('ends a line comment at every line terminator', () => {
    for (const end of ['\n', '\r', '\u2028', '\u2029']) {
      const code = `a = \`\${b // c${end}}\`; let h = \`\${1}\``
      assert.deepEqual(templates(code), [`\`\${b // c${end}}\``, '`${1}`'], JSON.stringify(end))
    }
  })

  it('leaves a template it can\'t close to Prism\'s pattern, rather than running it to the end', () => {
    // A text that doesn't parse, and one whose `{} / 2` the scan misreads:
    // its slash taken for a regex's, the regex runs on to the `/` past `}`.
    assert.deepEqual(templates('a = `b ${c({ d })} e\nlet f = 1'), [])
    const code = 'a = `x${{} / 2}/-text`; let h = 1'
    assert.deepEqual(templates(code), ['`x${{} / 2}/-text`'])
    assert.deepEqual(typesAt(code, 'x$'), ['template-string', 'string'])
    assert.deepEqual(typesAt(code, '${'), ['template-string', 'interpolation', 'interpolation-punctuation'])
    assert.deepEqual(typesAt(code, '2}'), ['template-string', 'interpolation', 'number'])
    assert.deepEqual(typesAt(code, '/-text'), ['template-string', 'string'])
    assert.deepEqual(typesAt(code, 'let'), ['keyword'])
  })

  it('counts what it leaves open within one highlight, not across them', () => {
    // A template it leaves open, then the lit templates only the scan reads:
    // were the count kept from one highlight to the next, the fifth would
    // hand them all to Prism's own pattern, and `var` would be in a string.
    const code = `z = \`\${{} / 2}/-\`;\n${nav}`
    for (let i = 1; i <= 6; i++) assert.deepEqual(typesAt(code, 'var mn'), ['keyword'], `highlight ${i}`)
  })

  it('does the same in TypeScript, JSX, TSX and a markup <script>', () => {
    for (const lang of ['typescript', 'jsx', 'tsx']) {
      assert.deepEqual(templates(nav, lang)[0], header, lang)
      assert.deepEqual(typesAt(nav, 'var mn', lang), ['keyword'], lang)
      assert.deepEqual(templates('a = `${{} / 2}/-text`', lang), ['`${{} / 2}/-text`'], lang)
    }
    assert.deepEqual(templates(`<script>${nav}</script>`, 'markup')[0], header)
  })
})
