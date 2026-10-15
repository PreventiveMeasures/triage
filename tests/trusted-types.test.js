// The pages require Trusted Types (`require-trusted-types-for 'script'`
// in their CSP), and a browser enforces that by throwing at the sink: a
// plain string set as `innerHTML`, a policy the CSP doesn't name. Nothing
// under Node runs that check, so this holds the pieces it depends on
// together: the app's policy, the policies each page admits against the
// ones its scripts create, and the sinks in ui/ taking trusted values —
// markup only through view/markup.js's check (tests/markup.test.js).
import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { build } from 'esbuild'
import { litSvgAsHtml } from '../build-lit-svg.js'

test('the app policy blesses the app\'s own markup, sets any other as text, and a script only from its own origin', async (t) => {
  const refused = t.mock.method(console, 'error', () => {})
  const policies = new Map()
  globalThis.trustedTypes = {
    createPolicy(name, rules) {
      policies.set(name, rules)
      return { createHTML: html => ({ html: rules.createHTML(html) }), createScriptURL: url => ({ url: rules.createScriptURL(url) }) }
    },
  }
  globalThis.location = new URL('https://deepview.example/team/a/report/b')
  try {
    const { trustedHTML, trustedScriptURL } = await import('../ui/view/trusted-types.js?policy')
    assert.deepEqual([...policies.keys()].toSorted(), ['deepview', 'lit-html'], 'its own, and Lit\'s through markup.js')
    assert.deepEqual(trustedHTML('<svg></svg>'), { html: '<svg></svg>' })
    assert.deepEqual(trustedHTML('<img src=x onerror=alert(1)>'), { html: '&lt;img src=x onerror=alert(1)&gt;' })
    assert.equal(refused.mock.callCount(), 1, 'and reported')
    assert.deepEqual(trustedScriptURL(new URL('/brotli-fallback.js', location.href)), { url: 'https://deepview.example/brotli-fallback.js' })
    assert.deepEqual(trustedScriptURL('./chunk.js'), { url: 'https://deepview.example/team/a/report/chunk.js' })
    for (const url of ['https://elsewhere.example/brotli-fallback.js', '//elsewhere.example/x.js', 'http://deepview.example/x.js']) {
      assert.throws(() => trustedScriptURL(url), /Not a same-origin script/u, url)
    }
  } finally {
    delete globalThis.trustedTypes
    delete globalThis.location
  }
  // Without Trusted Types the markup is checked all the same, and the
  // values are the strings the sinks take.
  const { trustedHTML, trustedScriptURL } = await import('../ui/view/trusted-types.js?plain')
  assert.equal(trustedHTML('<span class="evd-lineno" aria-hidden="true">1</span>'), '<span class="evd-lineno" aria-hidden="true">1</span>')
  assert.equal(trustedHTML('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;')
  const url = new URL('https://deepview.example/x.js')
  assert.equal(trustedScriptURL(url), url)
})

// Directive name → its values, from a page's meta CSP.
function pageCsp(source) {
  const content = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/u.exec(source)?.[1]
  return new Map(content?.split(';').map(part => part.trim().split(/\s+/u)).map(([name, ...values]) => [name, values]) ?? [])
}

test('every page that runs a script requires Trusted Types, and admits the policies its scripts create', async () => {
  const { metafile, outputFiles } = await build({
    entryPoints: ['ui/*.js'], bundle: true, format: 'esm', splitting: true, chunkNames: 'chunk-[hash]',
    outdir: 'out', write: false, metafile: true, loader: { '.css': 'text' }, plugins: [litSvgAsHtml],
  })
  const created = new Map(outputFiles.map(file => [file.path.slice(file.path.lastIndexOf('/out/') + 1),
    [...file.text.matchAll(/createPolicy\(\s*["'`]([^"'`]+)/gu)].map(match => match[1])]))
  // The policies an entry and the chunks it statically imports create.
  const policiesOf = (output, seen = new Set()) => {
    if (seen.has(output)) return []
    seen.add(output)
    return [...created.get(output) ?? [], ...metafile.outputs[output].imports
      .filter(i => i.kind === 'import-statement').flatMap(i => policiesOf(i.path, seen))]
  }
  const pages = globSync('ui/*.html').map(path => [path, readFileSync(path, 'utf8')])
  const scripted = pages.filter(([, source]) => /<script\b/u.test(source))
  assert.ok(scripted.length >= 3, 'the app, the logs viewer and the GitHub callback')
  for (const [path, source] of scripted) {
    const csp = pageCsp(source)
    assert.deepEqual(csp.get('require-trusted-types-for'), ["'script'"], path)
    const admitted = csp.get('trusted-types')
    assert.ok(admitted, `${path} names its policies`)
    for (const [, src] of source.matchAll(/<script [^>]*src="\.\/([^"]+\.js)"/gu)) {
      for (const name of policiesOf(`out/${src}`)) assert.ok(admitted.includes(name), `${path} admits ${name}, which ${src} creates`)
    }
  }
  // The app loads its lazy entries by runtime path, out of esbuild's sight,
  // so its page admits every policy any of them creates, and no other.
  const admitted = pageCsp(readFileSync('ui/index.html', 'utf8')).get('trusted-types')
  assert.deepEqual([...new Set([...created.values()].flat())].toSorted(), admitted.toSorted())
  assert.deepEqual(admitted.toSorted(), ['deepview', 'lit-html'])
})

// The sinks Trusted Types guards that ui/ reaches outside Lit, each of
// which must be handed the app policy's value; and Lit's own ways to take
// a string as markup, which its `lit-html` policy blesses whatever the
// string, used by view/markup.js alone, behind its check.
test('HTML and script sinks in ui/ take a trusted value, and only markup.js takes a string as Lit markup', () => {
  const offenders = []
  for (const path of globSync('ui/**/*.js')) {
    readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/^\s*\/\/.*$/u, '').replace(/\s\/\/\s.*$/u, '')
      const at = `${path}:${i + 1}: ${line.trim()}`
      for (const [, rhs] of code.matchAll(/\.(?:inner|outer)HTML\s*=(?!=)\s*(.*)/gu)) if (!rhs.startsWith('trustedHTML(')) offenders.push(at)
      for (const [, arg] of code.matchAll(/\bnew\s+(?:Shared)?Worker\(\s*(.*)/gu)) if (!arg.startsWith('trustedScriptURL(')) offenders.push(at)
      if (/\.insertAdjacentHTML\(|\.setHTMLUnsafe\(|\bparseHTMLUnsafe\(|\bcreateContextualFragment\(|\bparseFromString\(|\bdocument\.write(?:ln)?\(|\.srcdoc\s*=|\bnew\s+Function\(|\beval\(/u.test(code)) offenders.push(at)
      if (path !== 'ui/view/markup.js' && /\bunsafe(?:HTML|SVG|MathML|Static)\b|lit\/directives\/unsafe-|lit-html\/directives\/unsafe-/u.test(code)) offenders.push(at)
    })
  }
  assert.deepEqual(offenders, [])
})
