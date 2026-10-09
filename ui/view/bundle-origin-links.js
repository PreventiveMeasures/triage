import { repoDirectory, reportRepoGithub } from '@preventive/report'
import { bundleCommitHash } from '../../common/bundle-commit.js'

const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu

// A tooltip cannot scroll, so a message's first line is cut short there.
const MAX_TOOLTIP_TITLE = 200

function tooltipTitle(message) {
  const line = message.split('\n').map(text => text.trim()).find(Boolean) ?? ''
  const chars = [...line]
  return chars.length > MAX_TOOLTIP_TITLE ? `${chars.slice(0, MAX_TOOLTIP_TITLE - 1).join('').trimEnd()}…` : line
}

function catalogTags(commitInfo, hash) {
  return hash && commitInfo?.sha === hash && Array.isArray(commitInfo.tags) ? commitInfo.tags.filter(tag => typeof tag === 'string' && tag) : []
}

// The `data-tooltip-commit-info` value (see tooltip.js) for `hash`, from the
// `commitInfo` a managed catalog sends with a bundle, when it is for that
// commit: the message's first line, author and date, and its tags when the
// tooltip names `repository`, the one they were cached for. A commit is the
// same in every repository that has it (a fork's network); its tags are not.
export function bundleCommitTooltip(commitInfo, hash, repository = null) {
  const cachedFor = typeof commitInfo?.github === 'string' && typeof repository === 'string' && repository.toLowerCase() === commitInfo.github.toLowerCase()
  const tags = cachedFor ? catalogTags(commitInfo, hash) : []
  const details = hash && commitInfo?.sha === hash && typeof commitInfo.details?.message === 'string' ? commitInfo.details : null
  if (!details && tags.length === 0) return undefined
  return JSON.stringify({ tags, ...(details ? { title: tooltipTitle(details.message),
    authorName: details.authorName, authorLogin: details.authorLogin, date: details.committedAt ?? details.authoredAt } : {}) })
}

// `commitInfo` is what a managed catalog sends for the bundle (see
// server-managed/bundle-commits.ts): the cached details of its recorded commit
// and the tags that point to it, which ride on that commit's link. Tags link
// to the repository they were cached for, the one the bundle is stored at,
// which can differ from the one its stamp names.
export function bundleOriginLinks(bundle, prefix = '', commitInfo = null) {
  const links = []
  const github = reportRepoGithub(bundle)
  if (github) {
    const directory = [repoDirectory(bundle.repo), repoDirectory({ directory: prefix })].filter(Boolean).join('/')
    const commit = bundleCommitHash(bundle.repo?.commit)
    const path = directory.split('/').map(encodeURIComponent).join('/')
    const base = `https://github.com/${github}`
    const tagRepository = reportRepoGithub({ repo: { github: commitInfo?.github } })
    const tags = tagRepository ? catalogTags(commitInfo, commit) : []
    links.push({ label: 'GitHub', text: github + (directory ? `/${directory}` : ''),
      href: commit || directory ? `${base}/tree/${commit ?? 'HEAD'}${path ? `/${path}` : ''}` : base,
      ...(commit ? { commit: { hash: commit, text: commit.slice(0, 7), href: `${base}/commit/${commit}`,
        ...(tags.length > 0 ? { tags: tags.map(tag => ({ name: tag,
          href: `https://github.com/${tagRepository}/releases/tag/${tag.split('/').map(encodeURIComponent).join('/')}` })) } : {}),
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
