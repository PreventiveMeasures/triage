import { repoDirectory, reportRepoGithub } from '@preventive/report'
import { bundleCommitHash } from '../../common/bundle-commit.js'

const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu

function catalogTags(commitInfo, hash) {
  return hash && commitInfo?.sha === hash && Array.isArray(commitInfo.tags) ? commitInfo.tags.filter(tag => typeof tag === 'string' && tag) : []
}

// The `data-tooltip-commit-info` value (see tooltip.js) for `hash`, from the
// `commitInfo` a managed catalog sends with a bundle, when it is for that
// commit: its tags, and the message's first line, author and date.
export function bundleCommitTooltip(commitInfo, hash) {
  const tags = catalogTags(commitInfo, hash)
  const details = hash && commitInfo?.sha === hash && typeof commitInfo.details?.message === 'string' ? commitInfo.details : null
  if (!details && tags.length === 0) return undefined
  return JSON.stringify({ tags, ...(details ? { title: details.message.split('\n').map(line => line.trim()).find(Boolean) ?? '',
    authorName: details.authorName, authorLogin: details.authorLogin, date: details.committedAt ?? details.authoredAt } : {}) })
}

// `commitInfo` is what a managed catalog sends for the bundle (see
// server-managed/bundle-commits.ts): the cached details of its recorded commit
// and the tags that point to it, which ride on that commit's link.
export function bundleOriginLinks(bundle, prefix = '', commitInfo = null) {
  const links = []
  const github = reportRepoGithub(bundle)
  if (github) {
    const directory = [repoDirectory(bundle.repo), repoDirectory({ directory: prefix })].filter(Boolean).join('/')
    const commit = bundleCommitHash(bundle.repo?.commit)
    const path = directory.split('/').map(encodeURIComponent).join('/')
    const base = `https://github.com/${github}`
    const tags = catalogTags(commitInfo, commit)
    links.push({ label: 'GitHub', text: github + (directory ? `/${directory}` : ''),
      href: commit || directory ? `${base}/tree/${commit ?? 'HEAD'}${path ? `/${path}` : ''}` : base,
      ...(commit ? { commit: { hash: commit, text: commit.slice(0, 7), href: `${base}/commit/${commit}`,
        ...(tags.length > 0 ? { tags: tags.map(tag => ({ name: tag, href: `${base}/releases/tag/${tag.split('/').map(encodeURIComponent).join('/')}` })) } : {}),
      } } : {}) })
  }
  const npm = bundle?.package?.npm
  if (typeof npm?.name === 'string' && NPM_NAME_RE.test(npm.name)) {
    const version = typeof npm.version === 'string' ? npm.version.trim() : ''
    links.push({ label: 'npm', text: npm.name + (version ? `@${version}` : ''),
      href: `https://www.npmjs.com/package/${npm.name}${version ? `/v/${encodeURIComponent(version)}` : ''}` })
  }
  return links
}
