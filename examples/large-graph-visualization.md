# Large code graph prototype: dependency matrix

## Target scale

The supplied examples contain 5,345–26,423 files, 441–1,016 packages, and
11,432–66,321 graph edges. This prototype starts with one row and column per
package and expands selected packages into individual files in the same matrix.

## Research and choice

| Approach | Useful for | Limitation for this task |
| --- | --- | --- |
| Hierarchical edge bundling | Seeing relations between parts of a hierarchy with less line clutter | Individual paths and direction still need interaction to disambiguate |
| Zoomable graph maps | Stable navigation with detail introduced at successive zoom levels | Requires multiscale layout and routing; visible links still compete for space |
| Dependency matrix | Directed coupling, shared dependencies, cycles, and dense regions | Path following is less intuitive; large matrices need ordering, zoom, and drill-down |

The matrix is the prototype choice, not a claim that it wins every graph task.
A 2022 comparison tested overview tasks on 500-node directed networks and found
matrices most reliable across its tested tasks. The earlier controlled
comparison found an advantage for node-link diagrams on path finding.

Primary sources:

- Abdelaal et al., **Comparative Evaluation of Bipartite, Node-Link, and
  Matrix-Based Network Representations** (IEEE VIS 2022):
  <https://arxiv.org/abs/2208.04458>
- Ghoniem, Fekete, Castagliola, **A Comparison of the Readability of Graphs Using
  Node-Link and Matrix-Based Representations** (2004):
  <https://aviz.fr/wiki/uploads/Teaching/MatrixVsNodeLink.pdf>
- Holten, **Hierarchical Edge Bundles** (2006):
  <https://www.cs.jhu.edu/~misha/ReadingSeminar/Papers/Holten06.pdf>
- Nachmanson et al., **GraphMaps: Browsing Large Graphs as Interactive Maps** (2015):
  <https://arxiv.org/abs/1506.06745>

## Prototype behavior

- Bundle → Graph → **Matrix**. Rows import columns. A cell represents a count
  of distinct directed file imports, with color inherited from the importing
  package and intensity proportional to the log of the count.
- Structure order groups strongly connected components (sets mutually
  reachable through imports), then follows dependency order between them.
  Own source and all split own-source directories stay ahead of dependencies
  in every order, including when a dependency shares their cycle. Structure
  keeps cycle members together within those source/dependency sections.
  Other modules missing imports or importers come last. Package-internal imports
  do not count as connections to other modules for this ordering.
  Within a cycle, weighted dependency ordering favors imports above the diagonal
  and retains the alphabetical arrangement if it scores better. Cyclic groups have a magenta
  outline with no fill; only actual cyclic imports receive a cycle mark (magenta
  cells when zoomed out, corner marks when zoomed in). The group need not have
  a direct import between every pair. A collapsed package's ordinary internal
  imports alone do not mark it as cyclic.
- Select a row or use the side panel to inspect incoming/outgoing dependencies.
  Select a cell for its file imports grouped by target, with source links.
  Diagonal selections omit the duplicate reverse-direction link.
- **Expand files** preserves connections to other packages. **Neighborhood**
  and search reduce the visible set to a node/matches plus direct neighbors.
- Zoom with the buttons or Ctrl/Command + wheel, pan by dragging or scrolling,
  and use fixed row/column labels. Arrow keys select cells; Enter expands.
  Minimum zoom is the smaller of 100% and Fit. Empty cells have no hover tooltip.
- Existing Reason, Split dirs, theme, fullscreen, and finding highlights work
  with the new mode.

## Validation and limits

`node examples/large-graph-sample.js /tmp/dense-code-matrix.stasis.code.br`
generates a deterministic Stasis fixture at 26,423 files and 1,016 packages,
with 66,321 imports (35,210 internal and 31,111 cross-package), infrastructure
hubs, and deliberate cycles. It has **eight shortest-path package levels**, with
43–228 packages per dependency level and 22,788 distinct directed package pairs.
Package sizes vary, and the app contains 12% of the files. Cross-package imports
fan out across wide levels and shared dependencies; this replaces the original
unrepresentative chain-like fixture. All packages and files are reachable from
the app entry. The generator also accepts `layerCount` for five-to-ten-level cases.
These are directed import counts; the existing graph combines opposite
directions into one edge, so its edge total is not always identical.

The model stores existing edges rather than allocating an N × N array.
Iterative cycle detection avoids recursive stack overflow. The model tests
also expand all 26,423 files, check medium fixtures at five and ten package levels,
and exercise a 30,000-node cycle plus ordering of a 26,423-file cyclic group.
The canvas draws only cells intersecting the viewport. Matrix preparation
skips the existing all-files transitive-finding calculation.

This is a prototype: its 1,016-package overview reveals patterns but individual
labels require zoom or search. It does not provide multi-hop path tracing.
The details panel shows at most 80 example imports for a cell and the 60
strongest neighbors per direction, with the limits stated in the UI. The
matrix keeps the full data. Findings are available as highlights; the sample
bundle itself has no matched security report. Synthetic scale tests do not
establish performance for every real graph topology or bundle ingestion path.
