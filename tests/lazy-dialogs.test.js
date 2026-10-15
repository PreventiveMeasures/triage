import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'

// ui/dialogs.js, its own bundle, exports every dialog's opener; view/lazy-dialogs.js
// stands one in for each, under its name, loading the bundle on first use.
// Read as written: the dialogs themselves want a browser.
const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
const OPENER = /^export (?:(?:async )?function |const )((?:open|resolve)\w+)\b/gmu

test('ui/dialogs.js exports every dialog’s opener, and lazy-dialogs.js stands in for each by name', async () => {
  const files = (await readdir(new URL('ui/view/dialogs/', root))).filter(file => file.endsWith('-dialog.js') && file !== 'app-dialog.js')
  const openers = []
  for (const file of files) for (const [, name] of (await read(`ui/view/dialogs/${file}`)).matchAll(OPENER)) openers.push(`${name} ${file}`)
  const exported = [...(await read('ui/dialogs.js')).matchAll(/^export \{ (\w+) \} from '\.\/view\/dialogs\/([\w-]+\.js)'$/gmu)]
  assert.deepEqual(exported.map(([, name, file]) => `${name} ${file}`).toSorted(), openers.toSorted())
  const standIns = [...(await read('ui/view/lazy-dialogs.js')).matchAll(/^export const (\w+) = opener\('(\w+)'\)$/gmu)]
  for (const [, name, opened] of standIns) assert.equal(opened, name)
  assert.deepEqual(standIns.map(([, name]) => name).toSorted(), exported.map(([, name]) => name).toSorted())
})

test('outside view/dialogs/, dialogs are imported only through lazy-dialogs.js', async () => {
  const sources = []
  for (const dir of ['ui', 'client']) {
    for (const file of await readdir(new URL(`${dir}/`, root), { recursive: true })) {
      const path = `${dir}/${file}`
      if (/\.(?:js|ts)$/u.test(path) && !path.startsWith('ui/view/dialogs/') && path !== 'ui/dialogs.js') sources.push(path)
    }
  }
  const direct = []
  for (const path of sources) {
    const text = await read(path)
    if (/(?:\bfrom\s*|\bimport\s*\(?\s*)['"][^'"]*\/dialogs\/[^'"]+['"]/u.test(text)) direct.push(path)
  }
  assert.deepEqual(direct, [])
})
