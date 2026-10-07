import assert from 'node:assert/strict'
import { test } from 'node:test'
import { packageRepo as stasisPackageRepo } from '@exodus/stasis-core/bundle-util'
import { packageRepo } from '../ui/view/package-repo.js'

// The browser copy must read a package.json exactly as Stasis records a
// dependency's repository from it.
test('the browser packageRepo mirrors Stasis', () => {
  const urls = ['org/repo', 'github:org/repo', 'Org/Repo.git', 'git+https://github.com/org/repo.git#main', 'git@github.com:org/repo.git',
    'ssh://git@github.com/org/repo.git', 'git+ssh://git@github.com:org/repo.git', 'https://github.com:443/org/repo/', 'https://www.github.com/org/repo',
    'https://gitlab.com/org/repo', 'https://github.com.evil.test/org/repo', 'https://evil.example?@github.com/org/repo', 'javascript:alert(1)',
    'example.org/docs', 'org', '', '  org/repo  ', `org/${'r'.repeat(101)}`, `${'o'.repeat(40)}/repo`]
  const directories = [undefined, '', '.', './', '/', '/.', 'packages/dep', './packages/dep/', 'packages\\dep', 'a//b/./c', 'a/../b', '..', 'a/..',
    'dir with space', 'tab\there', `${'d'.repeat(1100)}`, 7]
  const homepages = [undefined, 'https://github.com/org/repo/tree/main/packages/dep#readme', 'https://github.com/org/repo/tree/main/.',
    'https://github.com/org/repo/tree/main/', 'https://github.com/Org/Repo/tree/v1/a%20b?x', 'https://github.com/org/repo/tree/main/%E0%A4%A',
    'https://github.com/other/repo/tree/main/lib', 'https://example.com/org/repo/tree/main/lib']
  const cases = [null, 'org/repo', [], {}, { repository: null }, { repository: 7 }, { repository: { url: 7 } }]
  for (const url of urls) {
    cases.push({ repository: url })
    for (const directory of directories) cases.push({ repository: { type: 'git', url, directory } })
    for (const homepage of homepages) cases.push({ repository: url, homepage }, { repository: { url, directory: './' }, homepage })
  }
  for (const json of cases) assert.deepEqual(packageRepo(json), stasisPackageRepo(json), JSON.stringify(json))
})
