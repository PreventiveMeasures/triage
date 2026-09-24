export const managedCsvIds = ['https://example.test/finding/own', 'https://example.test/finding/dep']
export const managedCsv = [
  'finding_url,repository,title,description,severity,configured_scan_id,relevant_paths',
  `${managedCsvIds[0]},o/r,Own finding,First scan,high,scan:one,src/a.js`,
  `${managedCsvIds[1]},o/r,Dependency finding,Second scan,medium,scan:two,node_modules/pkg/b.js`,
].join('\n') + '\n'
