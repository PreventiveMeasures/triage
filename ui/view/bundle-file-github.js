import { repoDirectory, reportRepoGithub } from '@preventive/report'
import { bundleCommitHash } from '../../common/bundle-commit.js'
import { bundleSourcePackageInfo } from './bundle-source-package.js'
import { moduleEcosystem } from './bundle-source-tree.js'

function fileLink(github, directory, file, commit, pkg) {
  const path = [directory, file].filter(Boolean).join('/')
  const hash = bundleCommitHash(commit)
  return {
    href: `https://github.com/${github}/blob/${hash ?? 'HEAD'}/${path.split('/').map(encodeURIComponent).join('/')}`,
    github, path, commit: hash,
    package: typeof pkg?.name === 'string' && pkg.name ? { name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem } : null,
  }
}

// Where a stasis bundle file sits on GitHub, and the package it ships in,
// from the nearest module that records it, at the recorded commit if any.
// Own source follows the bundle's stamp, with what it leaves out taken from
// `assigned`, the repository and directory a managed bundle is stored at; a
// dependency follows its own repository (recorded, or its captured
// package.json's, as the package tooltips read it), never the application's.
// Best effort: a directory nothing records is taken for the repository root,
// as the Overview's origin link takes it.
export function bundleFileGithub(details, path, assigned = null) {
  if (details?.kind !== 'stasis' || typeof path !== 'string') return null
  const bundle = details.bundle
  let owner = null
  for (const [dir, info] of bundle?.modules ?? []) {
    const rel = dir === '.' ? path : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null
    if (rel !== null && Object.hasOwn(info.files, rel)) { owner = { dir, info, rel }; break }
  }
  if (!owner) return null
  const { dir, info, rel } = owner
  const ecosystem = moduleEcosystem(dir, info, null) ?? (dir.split('/').includes('node_modules') ? 'npm' : undefined)
  if (ecosystem === undefined) {
    const stamped = reportRepoGithub(bundle)
    const stored = reportRepoGithub({ repo: { github: assigned?.github } })
    const github = stamped ?? stored
    if (!github) return null
    // A stored directory places only the stored repository's files.
    const directory = typeof bundle.repo?.directory === 'string' ? repoDirectory(bundle.repo)
      : stored?.toLowerCase() === github.toLowerCase() ? repoDirectory({ directory: assigned.directory }) : ''
    return fileLink(github, directory, path, stamped ? bundle.repo?.commit : undefined, null)
  }
  const pkg = bundleSourcePackageInfo({ name: info.name, ecosystem }, info, 0)
  if (!pkg.github) return null
  return fileLink(pkg.github, pkg.directory ?? '', rel, reportRepoGithub(info) ? info.repo.commit : undefined, pkg)
}
