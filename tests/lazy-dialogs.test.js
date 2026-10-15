import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'

// ui/dialogs.js, its own bundle, exports every dialog's opener; view/lazy-dialogs.js
// stands one in for each, under its name, loading the bundle on first use. A
// few are held up front, imported by their callers directly (lazy-dialogs.js
// says why). Read as written: the dialogs want a browser.
const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
const OPENER = /^export (?:(?:async )?function |const )((?:open|resolve)\w+)\b/gmu
const UP_FRONT = new Set(['passkey-unlock-dialog.js', 'proxy-auth-dialog.js', 'sync-auth-dialog.js', 'triage-conflict-dialog.js'])

test('every dialog’s opener but those up front is in ui/dialogs.js, with a stand-in in lazy-dialogs.js', async () => {
  const files = (await readdir(new URL('ui/view/dialogs/', root))).filter(file => file.endsWith('-dialog.js') && file !== 'app-dialog.js')
  const openers = []
  for (const file of files) for (const [, name] of (await read(`ui/view/dialogs/${file}`)).matchAll(OPENER)) openers.push(`${name} ${file}`)
  const exported = [...(await read('ui/dialogs.js')).matchAll(/^export \{ (\w+) \} from '\.\/view\/dialogs\/([\w-]+\.js)'$/gmu)]
  assert.deepEqual(exported.map(([, name, file]) => `${name} ${file}`).toSorted(), openers.filter(opener => !UP_FRONT.has(opener.split(' ')[1])).toSorted())
  const standIns = [...(await read('ui/view/lazy-dialogs.js')).matchAll(/^export const (\w+) = opener\('(\w+)'\)$/gmu)]
  for (const [, name, opened] of standIns) assert.equal(opened, name)
  assert.deepEqual(standIns.map(([, name]) => name).toSorted(), exported.map(([, name]) => name).toSorted())
})

test('outside view/dialogs/, dialogs are imported only through lazy-dialogs.js, but those up front', async () => {
  const sources = []
  for (const dir of ['ui', 'client']) {
    for (const file of await readdir(new URL(`${dir}/`, root), { recursive: true })) {
      const path = `${dir}/${file}`
      if (/\.(?:js|ts)$/u.test(path) && !path.startsWith('ui/view/dialogs/') && path !== 'ui/dialogs.js') sources.push(path)
    }
  }
  const direct = []
  for (const path of sources) {
    for (const [, specifier] of (await read(path)).matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]*\/dialogs\/[^'"]+)['"]/gu)) {
      if (!UP_FRONT.has(specifier.split('/').at(-1))) direct.push(`${path} ${specifier}`)
    }
  }
  assert.deepEqual(direct, [])
})
