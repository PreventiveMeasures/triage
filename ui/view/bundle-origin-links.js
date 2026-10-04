import { repoDirectory, reportRepoGithub } from '@preventive/report'
import { bundleCommitHash } from '../../common/bundle-commit.js'

const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu

export function bundleOriginLinks(bundle, prefix = '') {
  const links = []
  const github = reportRepoGithub(bundle)
  if (github) {
    const directory = [repoDirectory(bundle.repo), repoDirectory({ directory: prefix })].filter(Boolean).join('/')
    const commit = bundleCommitHash(bundle.repo?.commit)
    const path = directory.split('/').map(encodeURIComponent).join('/')
    const base = `https://github.com/${github}`
    links.push({ label: 'GitHub', text: github + (directory ? `/${directory}` : ''),
      href: commit || directory ? `${base}/tree/${commit ?? 'HEAD'}${path ? `/${path}` : ''}` : base,
      ...(commit ? { commit: { hash: commit, text: commit.slice(0, 7), href: `${base}/commit/${commit}` } } : {}) })
  }
  const npm = bundle?.package?.npm
  if (typeof npm?.name === 'string' && NPM_NAME_RE.test(npm.name)) {
    const version = typeof npm.version === 'string' ? npm.version.trim() : ''
    links.push({ label: 'npm', text: npm.name + (version ? `@${version}` : ''),
      href: `https://www.npmjs.com/package/${npm.name}${version ? `/v/${encodeURIComponent(version)}` : ''}` })
  }
  return links
}
