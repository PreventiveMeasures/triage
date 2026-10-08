import { optimizeSunflowerOrder } from './sunflower-order.js'

// Refine the existing outer layout without moving its slots or changing ring
// membership. Each connected package pair contributes once, regardless of how
// many file imports were used to seed the layout. The center package is absent
// from the rings, but its edges still contribute to every swap's cost.
export function optimizePackageRings(pkgInfo, pkgEdgesOf, rings) {
  const nodes = [...pkgInfo].map(([file, info]) => ({ file, ...info }))
  const byPackage = new Map(nodes.map(node => [node.file, node]))
  const edges = []
  for (const [pkg, neighbors] of pkgEdgesOf) {
    for (const neighbor of neighbors.keys()) {
      if (pkg < neighbor) edges.push({ a: pkg, b: neighbor })
    }
  }
  const groups = rings.map(ring => ring.map(pkg => byPackage.get(pkg)))
  optimizeSunflowerOrder({ nodes, edges }, groups, { radiusOf: node => node.groupR })
  for (const node of nodes) {
    const info = pkgInfo.get(node.file)
    info.x = node.x; info.y = node.y
  }
}
