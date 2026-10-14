// What a file's code can do beyond itself, for a reviewer: run a string as
// code (eval, Function with new or without, node:vm, Module's _compile) or
// other programs (child_process), reach for credentials (a credential file's
// path, a token's name, `gh auth token`, the cloud's instance metadata, the
// GitHub Actions runner's process or another process's memory, trufflehog)
// or the whole environment, publish to npm (`npm publish`, `/-/whoami`, a
// registry PUT), run a shell command fetching or handing off code (`curl …
// https://…`, `| sh`, `powershell -…`, rundll32, osascript, `/dev/tcp/`),
// and name a place code runs from again later (a shell's rc file,
// LaunchAgents, systemd's user units, `.claude/settings.json`,
// `.vscode/tasks.json`), as a file's stamps say (stamps.js) and a version's
// findings name what is new to a file. A shell script (`.sh`, `.bat`, `.ps1`
// …, or a shell's hashbang) is read whole for the last two and the
// credentials a command reaches for, its text its commands.
// A quick read, not a parse: a script's code with its strings, regular
// expressions and comments set aside as script.js tells them, its
// strings read for the paths, names and commands they hold, a module by the
// string naming it where it is loaded (`require('child_process')`,
// `import … from 'node:child_process'`); a declaration file (.d.ts) read as
// TypeScript, as node runs it (stripping its types, `declare function
// eval(…)` among them, a function named, not called). A call written not to
// read as one (`window['ev' + 'al']`) goes unseen, as does one in a template
// literal in another's substitution (`${`${eval(x)}`}`), whose backtick ends
// the outer one as the regular expression telling strings reads it.
//
// Labels to assist a reviewer, making the plain cases less likely to be
// missed, not a check to rely on: code can come to eval, Function,
// child_process, credentials or the registry in more ways than any reading of
// its text tells (a name built as it runs, `(…).constructor('…')`, a module
// required by a name computed, a path or URL put together, the
// registry's host read from config), so a file without a label is not one
// without them.
import { JS_STRING_OR_COMMENT, NPM_MAX_FOUND, lineOf, npmIsScript } from './script.js'

// What may come between a call's parts: blanks and comments
// (`Function/* note */(…)`), each comment ending at its first `*/`.
const COMMENT = String.raw`/\*(?:[^*]|\*(?!/)){0,100}\*/|//[^\n]{0,100}\n`
const GAP = String.raw`(?:\s|${COMMENT})*`
// Function called: as it is, optionally (`Function?.(…)`), or by its call or
// apply (`Function.call(null, …)`), each making a function of its last
// argument.
const FUNCTION_CALLED = String.raw`(?:${GAP}\??\.${GAP}(?:call|apply))?${GAP}(?:\?\.${GAP})?\(`
// But not where the function made returns `this` alone
// (`Function('return this')()`, `new Function("return this;")`): the global
// object, as older code finds it where `globalThis` may not be, lodash's and
// core-js's among them, running nothing of its own.
const GLOBAL_FOUND = String.raw`(?!${GAP}(?<quote>["'\u0060])\s*return\s+this\s*;?\s*\k<quote>${GAP}\))`
// The environment, whole: not one variable of it (`process.env.HOME`,
// `process.env[name]`).
const ENV = String.raw`process${GAP}\.${GAP}env(?![\p{ID_Continue}$])(?!${GAP}(?:\??\.|\[))`
// Its values read out whole (`JSON.stringify(process.env)`,
// `Object.entries(process.env)`, `new URLSearchParams(process.env)`), or a
// copy of them (`JSON.stringify({ ...process.env })`), not as a program is
// handed it (`{ env: process.env }`, `{ ...process.env }`), nor its
// names listed (`Object.keys(process.env)`, as debug picks its DEBUG_ ones),
// nor one variable asked for (`'HOME' in process.env`), nor its entries or
// values picked among as they are read (`Object.entries(process.env)
// .reduce(…)`, as npm's agent finds its proxy's, `.filter(…)`, `.find(…)`).
const PICKED = String.raw`${GAP}\)${GAP}\??\.${GAP}(?:filter|find|findLast|some|every|reduce)(?![\p{ID_Continue}$])`
const COPY = String.raw`(?:\{${GAP}\.\.\.${GAP})?`
const ENV_WHOLE = String.raw`(?=JSON|Object|URLSearchParams)(?<![\p{ID_Continue}$.])(?:JSON${GAP}\.${GAP}stringify|URLSearchParams)${GAP}\(${GAP}${COPY}${ENV}`
  + String.raw`|(?=Object)(?<![\p{ID_Continue}$.])Object${GAP}\.${GAP}(?:values|entries)${GAP}\(${GAP}${COPY}${ENV}(?!${PICKED})`
// What a shell command, and a place code runs from again later, may say
// (SHELL, PERSISTENCE), and trufflehog (TRUFFLEHOG).
// A shell, as a hashbang or a pipe names it (`#!/bin/ksh`, `| fish`,
// BusyBox's `ash`, `| powershell`); after a pipe, by its path or env's too (`| /bin/sh`,
// `| /usr/bin/env bash`), env's options, their values, and settings before
// it on its line (`env -S`, `env -u NAME`, `env MODE=x`).
const SHELLS = String.raw`(?:(?:ba|z|da|k|mk|c|tc|fi|a)?sh|pwsh|powershell)`
const SHELL_PATH = String.raw`(?:(?:\/[\w.-]{1,40}){0,8}\/)?(?:env(?:[^\S\n]+(?:-[\w-]{1,20}(?:=\S{0,100}|[^\S\n]+(?!-)[^\s=]{1,100})?|\w{1,40}=\S{0,100})){0,6}[^\S\n]+)?`
const SHELL_OR_PLACE = String.raw`curl|wget|\|\s*(?:sudo|${SHELL_PATH}${SHELLS})|powershell|pwsh|rundll32|osascript|mshta|certutil|bitsadmin|\/dev\/(?:tcp|udp)|iex|invoke-expression`
  + String.raw`|\$profile|profile\.ps1|config\.fish|conf\.d|bashrc|zshrc|zshenv|zlogin|bash_profile|bash_login|zprofile|\.profile|Launch(?:Agents|Daemons)|systemd|systemctl|\.claude|\.vscode|trufflehog`
// What says one of the credentials a command, an endpoint or a process holds
// (HOLDS' gh-token, cloud-metadata, runner-worker and process-memory), as
// code and its strings may say it: `gh auth token`, and a string naming gh
// (`'gh'`, `'/usr/bin/gh'`), as a program run with its arguments apart is,
// whatever is between them (`'gh', ['auth', /* … */ 'token']`).
const SAYS_CREDENTIALS = String.raw`auth[^\S\n]+token|["'\x60\/\\]gh(?:\.exe)?["'\x60]|169\.254\.169\.254|metadata\.google\.internal|Runner\.Worker|\/proc\/`
// Any of RUNS_CODE, as a text may say it: a shell command or a place in any
// case, as Windows' are written (`PowerShell`, `RUNDLL32`).
const SAYS_SHELL_OR_PLACE = new RegExp(SHELL_OR_PLACE, 'iu')
const SAYS_CODE = new RegExp(String.raw`eval|Function${FUNCTION_CALLED}|vm["'\x60]|_compile|child_process|\.(?:npmrc|ssh|aws)|_TOKEN|${SAYS_CREDENTIALS}|(?:stringify|values|entries|URLSearchParams)${GAP}\(${GAP}(?:\{${GAP}\.\.\.${GAP})?process${GAP}\.${GAP}env|publish|whoami|registry\.(?:npmjs\.org|yarnpkg\.com)`, 'u')
const SAYS_ANY = { test: text => SAYS_CODE.test(text) || SAYS_SHELL_OR_PLACE.test(text) }

// A name read as one, not as a property's (`vm.eval`, `vm . eval`, a spread's
// `...eval` aside) or part of another's (`evaluate`), or as the global
// object's (`window.eval`, `globalThis?.eval`); looked back on only where the
// name or the global object's starts, so a long run of blanks reads in one go.
const GLOBAL = 'globalThis|window|global|self'
const named = name => String.raw`(?=${GLOBAL}|${name})(?<![\p{ID_Continue}$#])(?<!(?<!\.)\.${GAP})(?<!\bfunction${GAP})(?:(?:${GLOBAL})${GAP}\??\.${GAP})?${name}`
// A token's name, as its value is read (`process.env.GITHUB_TOKEN || null`,
// `env.NPM_TOKEN`, `||=`), not where its absence is told
// (`!process.env.GITHUB_TOKEN`, `!(process.env.GITHUB_TOKEN)`) or it is
// dropped (`delete process.env.NPM_TOKEN`), the token the whole of what is
// negated or deleted (ABSENT_ENDS: not `!process.env.GITHUB_TOKEN.trim()`,
// `!(process.env.GITHUB_TOKEN === x)`), nor where it is only set
// (`process.env.NPM_TOKEN = token`), but for a default as it is destructured
// (`{ NPM_TOKEN = '' } = process.env`, a line of its own too), nor declared
// (`const NPM_TOKEN = …`, TypeScript's `let GITHUB_TOKEN: string`), nor typed
// (a member, `GITHUB_TOKEN?: string`, `NPM_TOKEN: string | undefined`, or a
// parameter): looked back on, a few names and dots at most, only where the
// name starts.
const TOKEN_VAR = '(?:NPM|GITHUB)_TOKEN'
const SET = String.raw`\s{0,4}=(?![=>])`
// A name typed, not read: optional (`?:`), or a primitive's type after it,
// as no destructuring names what it reads (`{ NPM_TOKEN: token }`); not
// `undefined`, a ternary's choice (`x ? env.NPM_TOKEN : undefined`).
const TYPED = String.raw`\s{0,4}(?:\?:|:\s{0,4}(?:string|number|boolean|unknown|any)(?![\p{ID_Continue}$]))`
// What may follow a token negated or deleted whole: the parentheses around
// it closed, nothing read of what they hold (`!(token).trim()`, `!(token)()`), or else what
// ends an operand (`&&`, `||`, `??`, a ternary's `?`, `;`, `,`, `:`, `}`, `]`,
// the line's end).
const ABSENT_ENDS = String.raw`\s{0,4}(?:(?:\)\s{0,4}){1,4}(?![\s)]{0,8}(?:[.[(]|\?\.))|&&|\|\||\?\?|\?(?!\.)|[;,:}\]]|$)`
const TOKEN_NAME = String.raw`(?=NPM|GITHUB)(?<![\p{ID_Continue}$])(?<!\b(?:const|let|var)\s{1,4})`
  + String.raw`(?:(?<!(?:!|\bdelete\s)[\s(]{0,4}(?:[\p{ID_Continue}$]{1,64}\s{0,4}\??\.\s{0,4}){0,4})|(?!${TOKEN_VAR}${ABSENT_ENDS}))`
  + String.raw`${TOKEN_VAR}(?![\p{ID_Continue}$])(?!${TYPED})(?:(?!${SET})|(?<=[{,]\s{0,64}${TOKEN_VAR}))`
// A script's strings, regular expressions and comments, as script.js
// tells them, each taking its own text, and its code in none of them: eval,
// not a property TypeScript types as optional (`eval?: T`, JavaScript's `?:`
// none of its own), and Function called, but to find the global object;
// Module's _compile, called
// (`module._compile(source, filename)`) or hooked (`Module.prototype._compile
// = …`), not named in a type (`typeof Module.prototype._compile`); a token's
// name, its value read; the environment read out whole; and a PUT request's
// call (`axios.put(…)`).
const READS = new RegExp(String.raw`${JS_STRING_OR_COMMENT.source}|(?<eval>${named('eval')}(?![\p{ID_Continue}$])(?!\s*\?:))|(?<function>${named('Function')}${FUNCTION_CALLED}${GLOBAL_FOUND})`
  + String.raw`|(?<compile>\.${GAP}_compile(?:${FUNCTION_CALLED}|${GAP}=(?![=>])))|(?<tokens>${TOKEN_NAME})|(?<env>${ENV_WHOLE})|(?<put>\.${GAP}put${GAP}\()`, 'gmu')
// What a string holds that a kind is: a credential file's path, npm's, SSH's
// or AWS's (`~/.npmrc`, `.ssh/id_rsa`, `.aws/credentials`, not `x.npmrc` or
// `.sshd`); a token's name where it is read, the string the name alone (a
// key, `process.env['GITHUB_TOKEN']`) or the name expanded (a shell's or
// .npmrc's `$GITHUB_TOKEN`, `${NPM_TOKEN}`, cmd's `%NPM_TOKEN%`), not where
// text names it (`requires a token in GITHUB_TOKEN`); a credential a
// command, an endpoint or a process holds (`gh auth token`, the cloud's
// metadata endpoint, `Runner.Worker`, `/proc/<pid>/mem`, trufflehog, as
// HOLDS tells them); a command publishing (`npm publish`, `pnpm
// publish …`, options before it as npm takes them, `npm --tag next publish`)
// or the registry's who-am-I, a publisher's first step with a token. And the
// registry, where a PUT request is one publishing (REGISTRY_URL).
// Told first of a string by what any of them says.
const HOLDS_CODE = new RegExp(String.raw`\.(?:npmrc|ssh|aws)|_TOKEN|${SAYS_CREDENTIALS}|publish|whoami|registry\.`, 'u')
const HOLDS_ANY = { test: text => HOLDS_CODE.test(text) || SAYS_SHELL_OR_PLACE.test(text) }
// Before a token's name as a key, its absence told or the token dropped, as
// TOKEN_NAME tells of one as a name (`!process.env['GITHUB_TOKEN']`,
// `delete process.env['NPM_TOKEN']`): a few names and dots at most, and
// after it, its key's bracket closed, what may follow it whole (ABSENT_ENDS,
// not `!process.env['NPM_TOKEN'].length`). After it, the token set
// (`process.env['NPM_TOKEN'] = token`).
const KEY_SET = new RegExp(String.raw`^\s{0,4}\]${SET}`, 'u')
const KEY_ENDS = new RegExp(String.raw`^\s{0,4}\]${ABSENT_ENDS}`, 'mu')
const KEY_ABSENT = /(?:!|\bdelete\s)[\s(]{0,4}(?:[\p{ID_Continue}$]{1,64}\s{0,4}\??\.\s{0,4}){0,4}[\p{ID_Continue}$]{1,64}\s{0,4}(?:\?\.\s{0,4})?\[\s{0,4}$/u
// A string's text as JavaScript reads it, its escapes decoded (`\x2f`,
// `\u002f`, `\u{2f}`, sloppy mode's octal `\057`, `\/`, `\\`, `\n`, `\t`), a
// line continued (a backslash before a line's end) joined: what a URL in it
// spells, however its separators are escaped or its lines broken.
const ESCAPE = /\\(?:x([\da-f]{2})|u([\da-f]{4})|u\{([\da-f]{1,6})\}|([0-3][0-7]{0,2}|[4-7][0-7]?)|(\r\n|[^]))/giu
const CONTROLS = new Map([['n', '\n'], ['r', '\r'], ['t', '\t'], ['b', '\b'], ['f', '\f'], ['v', '\v']])
const LINE_ENDS = new Set(['\n', '\r', '\r\n', '\u2028', '\u2029'])
const unescaped = text => text.replace(ESCAPE, (escape, hex, unit, point, octal, char) => {
  if (char !== undefined) return LINE_ENDS.has(char) ? '' : CONTROLS.get(char) ?? char
  const code = octal === undefined ? Number.parseInt(hex ?? unit ?? point, 16) : Number.parseInt(octal, 8)
  return code <= 0x10_FFFF ? String.fromCodePoint(code) : escape
})
// The registry's host in a string, as JavaScript reads it (unescaped) and a
// URL's parsing does, its tabs and line breaks gone, as a URL's authority: after two slashes, backslashes URLs take for them too, or
// after an http(s) scheme's colon (its slashes optional there, as URLs take
// them), its userinfo between, to its last `@` before the URL's path, query or
// fragment, quotes and all, 256
// characters at most, as credentials are, so a URL's every start is read
// in bounded time (`https://registry.npmjs.org/`, `.npmrc`'s
// `//registry.npmjs.org/`, `https://${token}@registry.npmjs.org/`,
// `https:\\\\registry.npmjs.org`, `https:\x2f\x2fregistry.npmjs.org`,
// `https:registry.npmjs.org`); or starting the string, its whole or before its
// path, port, query or fragment (npm-profile's `'registry.npmjs.org'`, a URL joined,
// `'https://' + 'registry.npmjs.org/'`). Not in prose, as anywhere else
// (`registry.npmjs.org</span>`, `asks registry.npmjs.org`, `[registry.npmjs.org]`,
// `note:registry.npmjs.org`, `user@registry.npmjs.org`, `docs/registry.npmjs.org`).
const REGISTRY_HOST = String.raw`registry\.(?:npmjs\.org|yarnpkg\.com)`
const REGISTRY_URL = new RegExp(String.raw`(?:[/\\]{2}|\bhttps?:[/\\]?)(?:[^/\\?#]{0,256}@)?${REGISTRY_HOST}|^(["'\u0060])${REGISTRY_HOST}(?=\1$|[/:?#])`, 'iu')
const URL_STRIPPED = /[\t\n\r]/gu
// A shell command fetching or handing off code: curl or wget given a URL
// (`curl -fsSL https://…`, `ftp://`, `https:\/\/` as a string may escape
// it), long options before it too (`-H "Authorization: …"`), a quoted
// argument's `;`, `|` and `&` no command's end (`-d "a=1&b=2"`), its line
// continued too (`curl -fsSL \⏎ https://…`, `curl\⏎`, cmd's `^`,
// PowerShell's backtick), not the next line's, the next command's (`curl
// --version; echo https://…`) nor the next curl's, a download piped to a
// shell (`… | sh`, `payload|sudo -E -- bash`, `| ksh`, `| /bin/sh`, `cat
// hash | sh`, not a list of shells, `bash|zsh|sh`, a regular expression's
// alternatives, `(x|ss|sh)$`, nor `|| sh`, nor an escaped pipe, grep's
// `'bash\|zsh'`), PowerShell given options (`powershell -nop -enc …`),
// rundll32, osascript and mshta, certutil fetching (`certutil -urlcache -f
// http://…`) and bitsadmin's `/transfer`, and bash's network redirection
// (`/dev/tcp/host/port`), and PowerShell running what it fetches (`iex (iwr
// https://…).Content`, `irm https://… | iex`, long options before the pipe
// too, `iwr … -Headers @{…} | iex`, `IEX (New-Object
// Net.WebClient).DownloadString(…)`), its line continued by a backtick too,
// not the next pipeline's, `iex $x && iwr …`); in any case, as Windows' are
// written, and by its path (`/usr/bin/curl`).
const CONTINUED = String.raw`[\\^\u0060]\r?\n`
const ON_ITS_LINE = String.raw`(?:[^\n;|&]|${CONTINUED})`
// PowerShell's own, its backtick alone (not `\⏎`, a new statement there).
const POWERSHELL_CONTINUED = String.raw`\u0060\r?\n`
// A command's text up to its end, its arguments' quotes kept, a quote left
// open (`it's`) as any other character.
const ARGUMENTS = String.raw`(?:[^\n;|&"']|${CONTINUED}|"[^"\n]*"|'[^'\n]*'|"(?![^"\n]*")|'(?![^'\n]*'))`
const APART = String.raw`(?:[^\S\n]|${CONTINUED})`
// A command's options, a few, and their values (`-E`, `-u root`, `--now`),
// on its line or one continued.
const OPTIONS = String.raw`(?:${APART}+--?\w[\w-]*(?:=\S*|${APART}+(?!-)\S+)?){0,6}?`
const SHELL = String.raw`(?<![\w.-])(?:curl|wget)(?:\.exe)?${APART}(?:(?!(?:curl|wget)(?![\w-]))${ARGUMENTS}){0,2000}?["']?(?:https?|s?ftps?|scp):\\?\/\\?\/|(?<![|\\]|(?<![\w.\/-])${SHELLS}\s*)\|\s*(?:sudo${OPTIONS}(?:${APART}+--)?${APART}+)?${SHELL_PATH}${SHELLS}(?![\w)|$-])`
  + String.raw`|(?<![\w.-])(?:powershell|pwsh)(?:\.exe)?[^\S\n]+-\w|(?<![\w.-])(?:rundll32|osascript|mshta)(?:\.exe)?(?![\w-])`
  + String.raw`|(?<![\w.-])certutil(?:\.exe)?${APART}${ON_ITS_LINE}{0,100}?-urlcache|(?<![\w.-])bitsadmin(?:\.exe)?${APART}${ON_ITS_LINE}{0,100}?\/transfer|\/dev\/(?:tcp|udp)\/`
  + String.raw`|(?<![\w$.-])(?:iex|invoke-expression)(?![\w-])(?:[^\n;|&]|${POWERSHELL_CONTINUED}){0,200}?(?:(?<![\w$.-])(?:iwr|irm|invoke-webrequest|invoke-restmethod)(?![\w-])|\.downloadstring\s*\()`
  + String.raw`|(?<![\w$.-])(?:iwr|irm|invoke-webrequest|invoke-restmethod)(?![\w-])(?:(?!(?:iwr|irm|invoke-webrequest|invoke-restmethod)(?![\w-]))(?:[^\n;|&]|${POWERSHELL_CONTINUED})){0,2000}\|\s*(?:iex|invoke-expression)(?![\w-])`
// A place code runs from again later: a shell's rc file (`~/.bashrc`,
// `.zshrc`, `.zshenv`, `.zlogin`, `.bash_profile`, `.bash_login`,
// `.zprofile`, and `.profile` in a path, `~/.profile`, not a selector's
// class, nor one after another, `.nav`), PowerShell's profile (`$PROFILE`,
// `Microsoft.PowerShell_profile.ps1`, all hosts' `PowerShell\Profile.ps1`,
// `$PSHOME\Profile.ps1`, not another folder's), macOS's LaunchAgents and
// LaunchDaemons, fish's (`~/.config/fish/config.fish`, `conf.d`), systemd's
// user units (`~/.config/systemd/user`, `systemctl --user enable`, other
// options before it, `--now`, or `--user` after it in its command,
// `systemctl enable --user`; not `start`, which runs a unit once), and the
// settings an AI agent or an editor runs commands from on its own
// (`.claude/settings.json`, `.vscode/tasks.json`); in any case, as Windows'
// and macOS's paths are, a path's separator a slash or a backslash, escaped
// in a string as code writes it (`"\\.claude\\settings.json"`, `\/`).
const SEPARATOR = String.raw`(?:\\?\/|\\{1,2})`
const PERSISTENCE = String.raw`(?<![\w.-])\.(?:bashrc|zshrc|zshenv|zlogin|bash_profile|bash_login|zprofile)(?![\w-])|(?<=[\/\\])(?<!\.[\w-]*[\/\\])\.profile(?![\w-])|(?<![\w-])Launch(?:Agents|Daemons)(?![\w-])|systemd${SEPARATOR}user(?![\w-])|fish${SEPARATOR}(?:config\.fish|conf\.d)(?![\w-])`
  + String.raw`|(?<![\w$])\$profile(?![\w-])|(?<![\w.-])Microsoft\.\w+_profile\.ps1(?![\w-])|(?:PowerShell|\$pshome)${SEPARATOR}profile\.ps1(?![\w-])|systemctl${OPTIONS}${APART}+--user${OPTIONS}${APART}+enable(?![\w-])|systemctl${OPTIONS}${APART}+enable(?:${APART}+[^\s;|&]+){0,6}?${APART}+--user(?![\w-])|(?<![\w.-])\.claude${SEPARATOR}settings(?:\.local)?\.json|(?<![\w.-])\.vscode${SEPARATOR}tasks\.json`
// Credentials a command, an endpoint or a process holds, as recent npm
// malware reached for them: the GitHub CLI printing its token (`gh auth
// token`, by its path too, `gh.exe`), not its other commands (`gh auth
// status`); the cloud's instance metadata endpoint, AWS's, Azure's and GCP's
// (`http://169.254.169.254/latest/meta-data/…`, `metadata.google.internal`),
// not an address it starts (`169.254.169.2540`) nor Azure's instance metadata
// (`169.254.169.254/metadata/instance/compute`, its slashes escaped too,
// `\/`), a machine's region and size, not its identity's token, as msal asks
// it; the GitHub Actions runner's
// process (`Runner.Worker`, `Runner.Worker.exe`, `GitHub.Runner.Worker`),
// whose memory holds a job's secrets, not in another name (`MyRunner.Worker`,
// `Runner.Workers`) nor case (`runner.worker`); another process's memory, by
// its pid's digits or a glob (`/proc/1234/mem`, `/proc/*/mem`,
// `/proc/[0-9]*/mem`) or a substitution (`/proc/${pid}/mem`, a shell's
// `$pid`, `$(pgrep …)` and backticks, Python's `{pid}`, a format's `%d`),
// not a process's own (`/proc/self/mem`) nor what else /proc tells of one
// (`/proc/1234/status`); and trufflehog, a scanner for secrets, in any case
// (`TruffleHog`), not in another name (`trufflehogs`, `TRUFFLEHOG_VERSION`).
const GH_TOKEN = String.raw`(?<![\w.-])gh(?:\.exe)?[^\S\n]+auth[^\S\n]+token(?![\w-])`
const PID = String.raw`[\d*?[\]-]{1,20}|\$\{[^}\n]{0,100}\}|\$\([^)\n]{0,200}\)|\u0060[^\u0060\n]{0,200}\u0060|\$\w{1,64}|\{\w{0,64}\}|%d`
const TRUFFLEHOG = String.raw`(?<![\p{ID_Continue}$-])trufflehog(?![\p{ID_Continue}$-])`
const HOLDS = [
  ['credential-files', /(?<![\w$.-])\.(?:npmrc|ssh|aws)(?![\w-])/gu],
  ['tokens', new RegExp(String.raw`^["'\u0060]${TOKEN_VAR}["'\u0060]$|(?:\$\{?|%)${TOKEN_VAR}(?![\p{ID_Continue}$])`, 'gu')],
  ['gh-token', new RegExp(GH_TOKEN, 'gu')],
  ['cloud-metadata', /(?<![\w.])169\.254\.169\.254(?!\.?\d|\\?\/metadata\\?\/instance(?![\w-]))|(?<![\w.-])metadata\.google\.internal(?![\w-])/gu],
  ['runner-worker', /(?<![\w$-])Runner\.Worker(?![\w$-])/gu],
  ['process-memory', new RegExp(String.raw`\/proc\/(?:${PID})\/mem(?![\w-])`, 'gu')],
  ['trufflehog', new RegExp(TRUFFLEHOG, 'giu')],
  ['publish', /(?<![\w-])(?:npm|pnpm|yarn)(?:\s+-{1,2}\w[\w-]*(?:=\S*|\s+(?!-)\S+)?){0,8}?\s+publish(?![\w-])|\/-\/whoami(?![\w-])/gu],
  ['shell', new RegExp(SHELL, 'giu')],
  ['persistence', new RegExp(PERSISTENCE, 'giu')],
]
// What a shell script holds, read whole: its commands, the places they write
// to, and the credentials a command, a process or its memory holds (`gh auth
// token`, `Runner.Worker`, `/proc/<pid>/mem`, trufflehog); not the cloud's
// metadata endpoint, whose fetching is a shell command already (`curl
// http://169.254.169.254/…`) and which a script provisioning a machine asks
// its region and id, nor a credential file or a token, which a script
// publishing a package names.
const SHELL_KINDS = new Set(['gh-token', 'runner-worker', 'process-memory', 'trufflehog', 'shell', 'persistence'])
const SHELL_HOLDS = HOLDS.filter(([kind]) => SHELL_KINDS.has(kind))
// A shell script, by its extension, its name a shell's startup file's
// (`.bashrc`, `.profile`), or its hashbang: a shell's, by its path or env's,
// env's options and settings before it (`#!/bin/ksh`, `#!/usr/bin/env -S
// bash -e`, `#!/usr/bin/env -S MODE=x bash`, `#!/usr/bin/env pwsh`), past a
// byte order mark.
const SHELL_SCRIPT = /(?:\.(?:sh|bash|zsh|ksh|mksh|dash|ash|csh|tcsh|fish|command|bat|cmd|ps1|psm1)|(?:^|[\\/])\.(?:bashrc|zshrc|zshenv|zlogin|bash_profile|bash_login|zprofile|profile))$/iu
// A shell script's comment, a line's whole (`# curl … | sh`) or its end
// after a command (`echo ok # don't curl …`, `echo ok;# …`) where the quotes
// before it are closed, escapes read (`"a \" b"`, PowerShell's by a
// backtick), not in one (`"a # b"`), and no other `#` (`$#`, `<#`) is;
// PowerShell's, by its extension or hashbang, its blocks too (`<# … #>`,
// opened where a command or value may start, `$x=<# … #>1`, not in a
// string, `"<#"`, `"a <#"`, to the end where none closes); a batch file's, cmd's `::`
// and `REM` (`@REM`, and `REM` after `&` or `||`, `echo ok & REM …`); as
// none of its commands.
const SHELL_COMMENT = /^[ \t]*#.*$|^((?:[^'"\n#\\]|\\.|'[^'\n]*'|"(?:[^"\n\\]|\\.)*")*?[ \t;&|])#.*$/gmu
const POWERSHELL = /\.psm?1$/iu
const POWERSHELL_HASHBANG = /^\uFEFF?#!\s*\S*\/(?:env\s+(?:(?:-\S+|\w+=\S*)\s+)*)?pwsh(?![\w-])/u
const POWERSHELL_COMMENT = /^((?:[^'"\n#\u0060]|\u0060.|'[^'\n]*'|"(?:[^"\n\u0060]|\u0060.)*")*?)(?:(?<=^|[\s;({=,])<#[\s\S]*?(?:#>|(?![\s\S]))|(?<=^|[ \t;&|])#.*$)/gmu
const BATCH = /\.(?:bat|cmd)$/iu
const BATCH_COMMENT = /^[ \t]*@?(?:::|rem(?![\w-])).*$|(?<=&|\|\|)[ \t]*@?rem(?![\w-]).*$/gimu
const SHELL_HASHBANG = new RegExp(String.raw`^\uFEFF?#!\s*\S*\/(?:env\s+(?:(?:-\S+|\w+=\S*)\s+)*)?${SHELLS}(?![\w-])`, 'u')
// A directory and a file in it named apart, as path.join takes them
// (`join(home, '.claude', 'settings.json')`): a place code runs from again
// later where a file names both.
const PARTS = [
  ['claude', /^(["'\u0060])\.claude\1$/iu, /^(["'\u0060])settings(?:\.local)?\.json\1$/iu],
  ['vscode', /^(["'\u0060])\.vscode\1$/iu, /^(["'\u0060])tasks\.json\1$/iu],
]
// `.profile` named apart where the home directory is the part before it
// (`join(os.homedir(), '.profile')`, `resolve(process.env.HOME, …)`, `'~'`),
// not a selector's class alone.
const PROFILE = /^(["'\u0060])\.profile\1$/iu
const HOME_BEFORE = /(?:homedir\s*\(\s*\)|\b(?:HOME|USERPROFILE)|(["'\u0060])~\1)\s*,\s*$/u
// A module a kind loads: vm, child_process, and libnpmpublish, npm's own
// publishing.
const MODULES = [
  ['vm', /^(["'\u0060])(?:node:)?vm\1$/u],
  ['child-process', /^(["'\u0060])(?:node:)?child_process\1$/u],
  ['publish', /^(["'\u0060])libnpmpublish\1$/u],
]
// A string a program is run with publishing (`spawn('npm', ['publish'])`),
// after the one naming it, its options and their values between
// (`['--tag', 'next', 'publish']`), and a request's method set to PUT
// (`{ method: 'PUT' }`, `options.method = 'put'`).
const PROGRAM = /^(["'\u0060])(?:npm|pnpm|yarn)\1$/u
const PUBLISH = /^(["'\u0060])publish\1$/u
const OPTION = /^(["'\u0060])-/u
const ARGUMENTS_BETWEEN = new RegExp(String.raw`^(?:[\s,[]|${COMMENT})*$`, 'u')
const PUT = /^(["'\u0060])put\1$/iu
const METHOD = new RegExp(String.raw`\bmethod["']?${GAP}[:=]${GAP}$`, 'u')
// A program run with its arguments apart, by its path too (`spawn('curl',
// ['-fsSL', 'https://…'])`, `execFile('powershell.exe', ['-NoP', '-enc',
// …])`, `spawn('systemctl', ['--user', 'enable', …])`, `spawnSync('gh',
// ['auth', 'token'])`): its command line,
// its arguments' strings after its name, read as a shell command is, a
// variable's or a property's value between (`['-o', output, 'https://…']`,
// `outputs[i]`, `options?.out`), its first 20 arguments, however long.
const COMMAND = /^(["'\u0060])(?:\S*[\\/])?(?:curl|wget|certutil|bitsadmin|powershell|pwsh|systemctl|gh)(?:\.exe)?\1$/iu
// An argument a shell would need quoted, its separators no command's end
// (`'Cookie: a=b; c=d'`), its own double quotes single then.
const SEPARATES = /[;|&]/u
const VALUES_BETWEEN = new RegExp(String.raw`^(?:[\s,[\]\w$.?]|${COMMENT})*$`, 'u')
// A place named by its parts one after the other, as path.join takes them
// (`join(home, '.config', 'systemd', 'user')`), read as a path is.
const PLACE = new RegExp(PERSISTENCE, 'iu')
// What comes before a module's name where code loads it: `require(` (or
// `require?.(`), a bundler's `__require(` or `__non_webpack_require__(`,
// `import(`, `import` and `from`, comments allowed between
// (`import(/* webpackIgnore: true */ …)`); a name not loaded, as in a list of
// node's modules, is none, nor one a type-only import or export names
// (`import type { … } from`, `import type cp = require(`, comments allowed as
// in a load), which TypeScript erases (`import type from` imports a default
// named type, `import type = require(` one named so).
const LOADS = new RegExp(String.raw`(?:(?:require[\w$]*${GAP}(?:\?\.${GAP})?|\bimport${GAP})\(|\b(?:from|import))${GAP}$`, 'u')
const TYPE_ONLY = new RegExp(String.raw`\b(?:import|export)${GAP}type\b(?!${GAP}(?:from\b|=))[^;'"\x60]*(?:\bfrom|=${GAP}require${GAP}\()${GAP}$`, 'u')

// Each kind, in the order its tags show: its tag, what it does, its name in
// the tag's tooltip, a row of its own where kinds share the tag (a string run
// as code by any way, `eval`'s; a credential file, a token, a command, an
// endpoint or a process, `credentials`'), and for one marked as worse than
// the others' warning, `critical`: the whole environment read out,
// publishing, and a place code runs from again later.
const AS_CODE = { tag: 'eval', note: 'Runs a string as code' }
const CREDENTIALS = { tag: 'credentials', note: 'Reaches for credentials' }
export const RUNS_CODE = new Map([
  ['eval', { ...AS_CODE, name: 'eval' }],
  ['function', { ...AS_CODE, name: 'Function' }],
  ['vm', { ...AS_CODE, name: 'vm' }],
  ['compile', { ...AS_CODE, name: 'Module._compile' }],
  ['child-process', { tag: 'child_process', note: 'Runs other programs', name: 'child_process' }],
  ['credential-files', { ...CREDENTIALS, name: '.npmrc, .ssh or .aws' }],
  ['tokens', { ...CREDENTIALS, name: 'NPM_TOKEN or GITHUB_TOKEN' }],
  ['gh-token', { ...CREDENTIALS, name: 'gh auth token' }],
  ['cloud-metadata', { ...CREDENTIALS, name: '169.254.169.254 or metadata.google.internal' }],
  ['runner-worker', { ...CREDENTIALS, name: 'Runner.Worker' }],
  ['process-memory', { ...CREDENTIALS, name: '/proc/<pid>/mem' }],
  ['trufflehog', { ...CREDENTIALS, name: 'trufflehog' }],
  ['env', { tag: 'whole env', note: 'Reads out the whole environment', name: 'process.env, by JSON.stringify, Object.entries or values, URLSearchParams', mark: 'critical' }],
  ['publish', { tag: 'publish', note: 'Publishes to npm', name: 'npm publish, /-/whoami or a registry PUT', mark: 'critical' }],
  ['shell', { tag: 'shell', note: 'Runs shell commands fetching or handing off code', name: 'curl or wget a URL, | sh, powershell -…, iex, rundll32, osascript, /dev/tcp' }],
  ['persistence', { tag: 'persistence', note: 'Names a place code runs from again later', name: '.bashrc, .zshrc, $PROFILE, LaunchAgents, systemd user units, .claude/settings.json, .vscode/tasks.json', mark: 'critical' }],
])

// The kinds a file's code holds, each with the lines it is on, of the first
// NPM_MAX_FOUND places it does each, in RUNS_CODE's order; null for none, or
// for a file that is no script. A shell script's, read whole, are its shell
// commands and the places it names; one with a shell's hashbang is one
// whatever its extension, and read as JavaScript too where it is that, as
// a launcher (`#!/bin/sh` then `exec node "$0"`) is both.
export function npmRunsCode(path, text) {
  const script = npmIsScript(path, text)
  const shell = typeof text === 'string' && (SHELL_SCRIPT.test(path) || SHELL_HASHBANG.test(text))
  if (!script && !shell) return null
  const found = new Map()
  const at = (kind, offset) => {
    const offsets = found.get(kind)
    if (!offsets) found.set(kind, [offset])
    else if (offsets.length < NPM_MAX_FOUND) offsets.push(offset)
  }
  if (script) read(text, 0, at)
  if (shell && SAYS_ANY.test(text)) {
    // Its comments blanked, its lines where they were.
    const comments = BATCH.test(path) ? BATCH_COMMENT : POWERSHELL.test(path) || POWERSHELL_HASHBANG.test(text) ? POWERSHELL_COMMENT : SHELL_COMMENT
    const commands = text.replace(comments, (comment, command = '') => command + comment.slice(command.length).replaceAll(/[^\n]/gu, ' '))
    for (const [kind, holds] of SHELL_HOLDS) for (const { index } of commands.matchAll(holds)) at(kind, index)
  }
  // A PUT request publishing where the file names the registry; a place
  // named by its directory and its file apart.
  if (found.has('registry')) for (const offset of found.get('put') ?? []) at('publish', offset)
  for (const [part] of PARTS) if (found.has(`${part}-file`)) for (const offset of found.get(`${part}-dir`) ?? []) at('persistence', offset)
  if (![...RUNS_CODE.keys()].some(kind => found.has(kind))) return null
  const line = lineOf(text)
  return new Map([...RUNS_CODE.keys()].filter(kind => found.has(kind)).map(kind => [kind, [...new Set(found.get(kind).map(line))].toSorted((a, b) => a - b)]))
}

// Where code (a file's, or a template literal's substitution's, at `base` in
// the file) does a kind, as at(kind, offset), in order: its code's, what its
// strings hold, a string naming a module where it is loaded, and what a
// template literal's substitutions (`${eval(x)}`) do, code again, read as its
// own; a PUT request (`put`) and the registry's host (`registry`) as their
// own, for the file to pair. Most code says none of it at all, told before
// anything is read.
function read(code, base, at) {
  if (!SAYS_ANY.test(code)) return
  // The string before, and where, a place's part maybe; the command line
  // since a program's name, and where it is named; where the string before
  // ends; whether the strings since a program's name are its arguments, an
  // option or its value each, and whether the last is an option.
  let before = null, command = null, end = 0, option = false, program = false
  for (const { 0: token, 1: string, groups, index } of code.matchAll(READS)) {
    if (string === undefined) {
      for (const kind of CODE_KINDS) if (groups[kind]) at(kind, base + index)
      continue
    }
    if (string[0] === '/') continue
    const inner = string[0] === '`' && SAYS_ANY.test(string) ? substitutions(string) : []
    for (const [from, to] of inner) read(string.slice(from, to), base + index + from, at)
    // What a string holds, a template's text alone, its substitutions' code
    // read as code, its comments and regular expressions aside.
    const text = inner.length === 0 ? string : textOf(string, inner)
    // A token's name as the string's whole (`within` 0, its quote) is a key,
    // not one where its absence is told, it is dropped or only set.
    const keyed = () => {
      const after = code.slice(index + token.length, index + token.length + 20)
      return !KEY_SET.test(after) && (!KEY_ENDS.test(after) || !KEY_ABSENT.test(code.slice(Math.max(0, index - 300), index)))
    }
    // Each kind searched for before its places are listed, as matchAll copies
    // its regular expression each time.
    const held = HOLDS_ANY.test(text) ? HOLDS.flatMap(([kind, holds]) => text.search(holds) === -1 ? [] : [...text.matchAll(holds)].map(({ index: within }) => [kind, within])) : []
    for (const [kind, within] of held) if (kind !== 'tokens' || within > 0 || keyed()) at(kind, base + index + within)
    if (text.includes('registry.') && REGISTRY_URL.test(unescaped(text).replace(URL_STRIPPED, ''))) at('registry', base + index)
    for (const [kind, name] of MODULES) if (name.test(string) && loaded(code, index)) at(kind, base + index)
    if (PROFILE.test(string) && HOME_BEFORE.test(code.slice(Math.max(0, index - 100), index))) at('persistence', base + index)
    for (const [part, dir, file] of PARTS) {
      if (dir.test(string)) at(`${part}-dir`, base + index)
      if (file.test(string)) at(`${part}-file`, base + index)
    }
    if (program && ARGUMENTS_BETWEEN.test(code.slice(end, index))) {
      if (PUBLISH.test(string)) at('publish', base + index)
      program = OPTION.test(string) || option
      option = OPTION.test(string)
    } else program = false
    if (PROGRAM.test(string)) [program, option] = [true, false]
    if (command && command.arguments < 20 && VALUES_BETWEEN.test(code.slice(end, index))) {
      const argument = text.slice(1, -1)
      command.line += ` ${SEPARATES.test(argument) ? `"${argument.replaceAll('"', "'")}"` : argument}`
      command.arguments++
      const { line } = command
      const hit = SHELL_HOLDS.find(([, holds]) => line.search(holds) !== -1)
      if (hit) {
        at(hit[0], command.at)
        command = null
      }
    } else command = null
    if (COMMAND.test(string)) command = { arguments: 0, at: base + index, line: string.slice(1, -1) }
    if (before && before.text.length + text.length < 200 && ARGUMENTS_BETWEEN.test(code.slice(end, index))) {
      const [first, second] = [before.text.slice(1, -1), text.slice(1, -1)]
      if (!PLACE.test(first) && !PLACE.test(second) && PLACE.test(`${first}/${second}`)) at('persistence', before.at)
    }
    before = { text, at: base + index }
    if (PUT.test(string) && METHOD.test(code.slice(Math.max(0, index - 300), index))) at('put', base + index)
    end = index + token.length
  }
}

// The kinds code itself does, by READS' groups.
const CODE_KINDS = ['eval', 'function', 'compile', 'tokens', 'env', 'put']

// Whether the string at `index` in code names a module where it is loaded.
function loaded(code, index) {
  const before = code.slice(Math.max(0, index - 300), index)
  return LOADS.test(before) && !TYPE_ONLY.test(before)
}

// A template literal with its substitutions' code blanked, its text in place.
function textOf(template, inner) {
  const parts = []
  let from = 0
  for (const [start, end] of inner) {
    parts.push(template.slice(from, start), ' '.repeat(end - start))
    from = end
  }
  parts.push(template.slice(from))
  return parts.join('')
}

// Where each of a template literal's substitutions' code starts and ends, in
// it: from its `${` to the `}` that closes it.
function substitutions(template) {
  const found = []
  for (let i = template.indexOf('${'); i !== -1; i = template.indexOf('${', i)) {
    // Escaped by an odd run of backslashes before it (`\${`, not `\\${`).
    let run = 0
    while (template[i - 1 - run] === '\\') run++
    if (run % 2 === 1) {
      i += 2
      continue
    }
    const end = closing(template, i + 2)
    found.push([i + 2, end])
    i = end
  }
  return found
}

// A string, regular expression or comment where it starts, told as
// JS_STRING_OR_COMMENT tells them in a whole text.
const TOKEN = new RegExp(JS_STRING_OR_COMMENT.source, 'muy')

// Where the `}` closing code from `from` in a text is, or the text's end for
// none: the first its braces leave unbalanced, those in its strings, regular
// expressions and comments aside (`${/* } */ x}`, `${/}/.test(x)}`).
function closing(text, from) {
  let depth = 0
  for (let at = from; at < text.length; at++) {
    const char = text[at]
    // Tried where a token can start: a quote, a slash, or a run of blanks, a
    // comment's leading blanks taken from where they start.
    if ('"\'`/ \t'.includes(char)) {
      TOKEN.lastIndex = at
      const token = TOKEN.exec(text)
      if (token) {
        at += token[0].length - 1
        continue
      }
    }
    if (char === '{') depth++
    else if (char === '}' && depth-- === 0) return at
  }
  return text.length
}

// What `found` holds (npmRunsCode's kinds, hosts.js's services) that
// `was` didn't, each with its lines: what is new to a file, as its tags say,
// `was` null for one the version compared with didn't hold, or held none in.
// Null for none.
export function npmFoundAdded(found, was) {
  if (!found) return null
  const added = new Map([...found].filter(([kind]) => !was?.has(kind)))
  return added.size > 0 ? added : null
}

// The kinds any of `founds` holds, as their tags name them, in their order,
// a tag kinds share once: `eval, child_process`.
export const npmRunsCodeKinds = founds => [...new Set([...RUNS_CODE].filter(([kind]) => founds.some(found => found.has(kind))).map(([, { tag }]) => tag))].join(', ')

// What `found` holds (npmRunsCode's) but the kinds whose tags `tags` names,
// each with its lines; null for none.
export function npmRunsCodeWithout(found, tags) {
  const kept = new Map([...found ?? []].filter(([kind]) => !tags.has(RUNS_CODE.get(kind).tag)))
  return kept.size > 0 ? kept : null
}

// Its tags as a file's flags (file-flags.js), in their order, each once: a
// warning's (`high`), or for one marked worse, `critical`; none for none.
export const npmRunsCodeFlags = found => [...new Map([...found?.keys() ?? []].map(kind => RUNS_CODE.get(kind))
  .map(({ tag, mark }) => [tag, { name: tag, severity: mark ?? 'high' }])).values()]

