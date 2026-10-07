import { reportRepoGithub } from '@preventive/report'
import { bundleCommitHash } from '../../common/bundle-commit.js'
import { bundleSourcePackageInfo } from './bundle-source-package.js'
import { moduleEcosystem } from './bundle-source-tree.js'

// Where a stasis bundle file sits on GitHub, and the package it ships in,
// from the nearest module that records it: a dependency's own repository
// (recorded, or its captured package.json's, as the package tooltips read
// it), else the bundle's. Only a known location links — a repository and a
// directory in it — and a dependency never borrows the application's.
export function bundleFileGithub(details, path) {
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
  const pkg = ecosystem === undefined ? null : bundleSourcePackageInfo({ name: info.name, ecosystem }, info, 0)
  const location = pkg
    ? { github: pkg.github, directory: pkg.directory, commit: info.repo?.commit, file: rel }
    : { github: reportRepoGithub(bundle), directory: bundle.repo?.directory, commit: bundle.repo?.commit, file: path }
  if (!location.github || typeof location.directory !== 'string') return null
  const repoPath = [location.directory, location.file].filter(Boolean).join('/')
  const commit = bundleCommitHash(location.commit)
  return {
    href: `https://github.com/${location.github}/blob/${commit ?? 'HEAD'}/${repoPath.split('/').map(encodeURIComponent).join('/')}`,
    github: location.github,
    path: repoPath,
    commit,
    package: typeof pkg?.name === 'string' && pkg.name ? { name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem } : null,
  }
}
