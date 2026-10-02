import { repoDirectory, reportRepoGithub } from '@preventive/report'

const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

export function bundleOriginLinks(bundle) {
  const links = []
  const github = reportRepoGithub(bundle)
  if (github) {
    const directory = repoDirectory(bundle.repo)
    const commit = COMMIT_RE.test(bundle.repo?.commit ?? '') ? bundle.repo.commit : null
    const path = directory.split('/').map(encodeURIComponent).join('/')
    const base = `https://github.com/${github}`
    links.push({ label: 'GitHub', text: github + (directory ? `/${directory}` : ''),
      href: commit || directory ? `${base}/tree/${commit ?? 'HEAD'}${path ? `/${path}` : ''}` : base })
  }
  const npm = bundle?.package?.npm
  if (typeof npm?.name === 'string' && NPM_NAME_RE.test(npm.name)) {
    const version = typeof npm.version === 'string' ? npm.version.trim() : ''
    links.push({ label: 'npm', text: npm.name + (version ? `@${version}` : ''),
      href: `https://www.npmjs.com/package/${npm.name}${version ? `/v/${encodeURIComponent(version)}` : ''}` })
  }
  return links
}
