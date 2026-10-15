// What a report or GitHub wrote — a finding's description, an issue's or a
// pull request's body, a linked fix's preview — is drawn as text. Markup in
// it never reaches Lit as markup, a link it writes only ever points at
// http(s), and Prism, the one place markup is built from such text, escapes
// it. The CSP keeps injected markup from running script; this keeps it from
// being drawn at all, since a link or an overlay is harm enough on its own.
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { mock, test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'

// Every tag carries `data-probe`, and every link points at evil.example, so
// either one turning up as markup is the probe getting through.
const INJECTED = [
  '<img src=x data-probe onerror=alert(1)>',
  '<a data-probe href=https://evil.example/login style=position:fixed;inset:0>Session expired: sign in again</a>',
  '<script data-probe>alert(1)</script>',
  '<iframe data-probe srcdoc=x></iframe>',
  '<form data-probe action=https://evil.example/><button>go</button></form>',
  '<meta data-probe http-equiv=refresh content=0;url=https://evil.example/>',
  '<style data-probe>body{display:none}</style>',
  '<svg data-probe onload=alert(1)><a href=https://evil.example/><text>x</text></a></svg>',
  '<details data-probe open ontoggle=alert(1)>x</details>',
]
// Each one in every place the renderer treats differently.
const PLACES = [
  p => p,
  p => `**${p}**`,
  p => `\`${p}\``,
  p => `"${p}"`,
  p => `[${p}](https://ok.example/)`,
  p => `Intro.\n\n${p}\n\nOutro.`,
  p => `- ${p}\n- second`,
  p => `1. first\n2. ${p}`,
  p => `- outer\n  - ${p}`,
  p => `## ${p}`,
  p => `| a | b |\n|---|---|\n| ${p} | x |`,
  p => `\`\`\`\n${p}\n\`\`\``,
  p => `\`\`\`weird\n${p}\n\`\`\``,
  p => `\`\`\`html\n${p}\n\`\`\``,
  p => `\`\`\`js\nconst s = '${p}'\n\`\`\``,
]
const BODIES = INJECTED.flatMap(p => PLACES.map(place => place(p)))
const HOSTILE = BODIES.join('\n\n')
const PROBE = /data-probe|evil\.example/u
// Schemes no link may carry, however the markdown spells them.
const LINKS = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java&#x09;script:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,x', 'file:///etc/passwd', '//evil.example/x']
  .map(url => `[click](${url})`).join(' and ')

// The tags Prism writes: a token's span and its close.
const isPrismTag = tag => /^<span class="[\w -]+">$|^<\/span>$/u.test(tag)

// What of a rendered value Lit takes as markup: each template's static
// strings, and whatever an `unsafeHTML` was handed.
function markup(value) {
  if (Array.isArray(value)) return value.flatMap(markup)
  if (value?.strings) return [...value.strings.map(text => ({ text })), ...value.values.flatMap(markup)]
  const directive = value?.['_$litDirective$']
  if (directive?.directiveName === 'unsafeHTML') return [{ text: String(value.values[0]), unsafe: true }]
  return directive ? value.values.flatMap(markup) : []
}

// Every attribute value bound right after `href=`.
function hrefs(value) {
  if (Array.isArray(value)) return value.flatMap(hrefs)
  if (!value?.strings) return value?.['_$litDirective$'] ? value.values.flatMap(hrefs) : []
  return value.values.flatMap((bound, i) => [...(/\shref=["']?$/u.test(value.strings[i]) ? [String(bound)] : []), ...hrefs(bound)])
}

// The probe is drawn, as text: never in a template's own markup, and in an
// `unsafeHTML` string only as the escaped text between Prism's tags.
function assertText(rendered, what) {
  for (const { text, unsafe } of markup(rendered)) {
    if (!PROBE.test(text)) continue
    assert.ok(unsafe, `${what}: the probe is in a template's markup: ${text.slice(0, 120)}`)
    const tags = text.match(/<[^>]*>?/gu) ?? []
    assert.deepEqual(tags.filter(tag => !isPrismTag(tag)), [], `${what}: unsafeHTML is handed more than Prism's tags`)
  }
  assert.ok(PROBE.test(templateText(rendered)) || markup(rendered).some(({ text, unsafe }) => unsafe && PROBE.test(text)), `${what}: the text is still shown`)
  for (const href of hrefs(rendered)) assert.match(href, /^(?:https?:\/\/(?!evil\.example)|#|\/(?!\/))/u, `${what}: links to ${href}`)
}

// Prism colours a fenced block as the browser would, rather than leaving it
// plain until a download that never comes under Node.
const prism = await import('../ui/prism.js')
const { langForTag } = await import('../ui/view/prism-highlight.js')
let item = null
let fix = null
class TestDialog {
  static styles = []
  _finish() {}
  disconnectedCallback() {}
}
mock.module('../ui/view/code-highlight.js', { namedExports: { highlightedCode: (code, tag) => (langForTag(tag) && code ? prism.highlight(code, langForTag(tag)) : null) } })
mock.module('../ui/view/render.js', { namedExports: { render() {} } })
mock.module('../ui/view/dom.js', { namedExports: { report: null } })
mock.module('../ui/view/dialogs/app-dialog.js', { namedExports: { AppDialog: TestDialog, openAppDialog() {} } })
// The rest of each module stays real for the modules that import them.
const clientManaged = await import('../ui/view/client-managed.js')
const pullRequests = await import('../ui/view/managed-pull-requests.js')
mock.module('../ui/view/client-managed.js', { namedExports: { ...clientManaged, fetchRepositoryItem: () => Promise.resolve(item) } })
mock.module('../ui/view/managed-pull-requests.js', { namedExports: { ...pullRequests, managedFixes: { read: () => fix }, subscribeFixes: () => () => {} } })
const { renderHighlighted } = await import('../ui/view/render-finding.js')
const { findingCardInnerTemplate, tableRowInnerTemplate } = await import('../ui/view/render-finding.js')
const { flowText } = await import('../ui/view/format.js')
const { state } = await import('../client/state.ts')
await import('../ui/view/dialogs/repository-item-dialog.js')
await import('../ui/view/managed-fix-link.js')

test('markup in a description is drawn as text, wherever in the markdown it sits', () => {
  for (const body of BODIES) assertText(renderHighlighted(flowText(body)), JSON.stringify(body))
  assertText(renderHighlighted(flowText(HOSTILE)), 'all of them at once')
  assertText(renderHighlighted(HOSTILE, { paragraphs: false }), 'as one compact flow')
})

test('a link in a description goes to http(s) only, whatever scheme the markdown wrote — a link to GitHub stays a link', () => {
  const github = 'https://github.com/org/repo/blob/0123abc/src/a.js#L3-L9'
  const rendered = renderHighlighted(flowText(`${LINKS} and [fine](https://ok.example/a), see [src/a.js](${github})`))
  assert.deepEqual(hrefs(rendered), ['https://ok.example/a', github])
  assert.match(templateText(rendered), /href=https:\/\/github\.com\/org\/repo\/blob\/0123abc\/src\/a\.js#L3-L9 target="_blank"[^>]*>src\/a\.js</u)
  assert.match(templateText(rendered), /\[click\]\(javascript:alert\(1\)\)/u, 'a rejected link stays the text it was')
})

test('Prism escapes the code it colours, so its markup is only its own tags', () => {
  for (const lang of ['markup', 'javascript', 'typescript', 'tsx', 'markdown', 'css', 'json', 'bash', 'php', 'python', 'yaml', 'solidity', 'rust']) {
    for (const code of [HOSTILE, ...INJECTED]) {
      const html = prism.highlight(code, lang)
      const tags = html.match(/<[^>]*>?/gu) ?? []
      assert.deepEqual(tags.filter(tag => !isPrismTag(tag)), [], lang)
    }
  }
})

test('a finding from a report — its kanban card\'s detail and its row — draws the markup it carries as text', () => {
  state.reports = []
  const finding = { id: 'hostile', severity: 'high', confidence: 9, file: 'src/a.ts', line: 3, title: INJECTED.join(' '), description: HOSTILE,
    recommendation: INJECTED.join('\n\n'), reproduction: LINKS, _reportName: 'report.json' }
  assertText(findingCardInnerTemplate([finding]), 'the finding card')
  assertText(tableRowInnerTemplate([finding]), 'the finding row')
})

test('an issue\'s or a pull request\'s title and body from GitHub are drawn as text', async () => {
  const Dialog = customElements.get('repository-item-dialog')
  for (const kind of ['issues', 'pulls']) {
    const tile = { kind, number: 5, title: INJECTED.join(' '), author: 'grace', createdAt: Date.UTC(2026, 9, 1), updatedAt: Date.UTC(2026, 9, 2), closedAt: null,
      comments: 1, labels: [{ name: INJECTED[0], color: 'd73a4a' }], moreLabels: 0, state: 'open', draft: false, mergedAt: null, review: 'approved',
      checks: 'success', additions: 1, deletions: 1, head: INJECTED[1], base: 'main' }
    item = { ...tile, body: `The body.\n\n${HOSTILE}\n\n${LINKS}`, closes: [], closedBy: [], moreLinked: 0, commits: 1, files: 1, mergedBy: null }
    const dialog = Object.assign(new Dialog(), { repository: { repoId: 7, repo: 'org/repo' } })
    dialog.open({ number: 5, preview: tile })
    await setImmediate()
    assertText(dialog.render(), kind)
    assert.match(templateText(dialog.render()), /The body\./u, `${kind}: its body is shown`)
  }
})

test('a linked fix\'s preview shows its issue\'s or pull request\'s title and description as text', () => {
  const FixLink = customElements.get('managed-fix-link')
  for (const kind of ['pull', 'issues']) {
    const link = Object.assign(new FixLink(), { url: `https://github.com/org/repo/${kind}/42`, compact: true })
    fix = { title: INJECTED.join(' '), status: 'open', description: HOSTILE }
    assertText(link.render(), kind)
  }
})
