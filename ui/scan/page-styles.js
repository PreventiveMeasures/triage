import { css } from 'lit'

export const SCAN_PAGE_STYLES = css`
  /* The containing page owns the outer gutters, in both Manage and local. */
  :host { display: block; box-sizing: border-box; color: var(--text); }
  * { box-sizing: border-box; }
  .wrap { max-width: 68rem; margin: 0 auto; container: scan-page / inline-size; }
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: .65rem; min-height: 2.1rem; margin-bottom: .45rem; }
  .head-title { display: flex; align-items: center; gap: .65rem; }
  h1 { margin: 0; font-size: 1.65rem; font-weight: 600; letter-spacing: -.035em; }
  .head-tabs { display: inline-flex; margin-left: .7rem; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .head-tabs button { border: 0; border-right: 1px solid var(--border); padding: .25rem .6rem; color: var(--muted); background: transparent; font: inherit; font-size: .75rem; }
  .head-tabs button:last-child { border-right: 0; }
  .head-tabs button.active { color: var(--text); background: var(--surface-active); }
  .head-tabs button:hover { color: var(--text); }
  .source-choice.single-repository { grid-template-columns: 1fr; }
  .head-actions { margin-left: auto; display: flex; gap: .45rem; }
  button, select, input { font: inherit; }
  button { cursor: default; }
  button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .intro { margin: 0 0 1.15rem; max-width: 52rem; color: var(--muted); font-size: .82rem; line-height: 1.5; }
  .intro span { display: block; }
  .notice { margin: 0 0 1rem; padding: .55rem .7rem; border: 1px solid rgb(from var(--accent) r g b / .35); border-radius: 7px; color: var(--text); background: rgb(from var(--accent) r g b / .08); font-size: .78rem; }
  .setup { display: grid; gap: .85rem; }
  .panel { border: 1px solid var(--border); border-radius: 9px; background: var(--surface); overflow: hidden; }
  .panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: .7rem; padding: .72rem .9rem; border-bottom: 1px solid var(--border); }
  .panel-head h2 { margin: 0; font-size: .86rem; font-weight: 600; }
  .panel-head p { margin: 0; color: var(--muted); font-size: .72rem; }
  .bundle-choice { display: grid; grid-template-columns: minmax(16rem, 1.2fr) minmax(0, 1fr); gap: 1rem; align-items: end; padding: .85rem .9rem; }
  .field { display: grid; gap: .3rem; min-width: 0; }
  .field label, .scope-field > span { color: var(--muted); font-size: .68rem; }
  select { min-width: 0; height: 2rem; padding: .28rem .5rem; border: 1px solid var(--border); border-radius: 5px; color: var(--text); background: var(--bg); font-size: .76rem; }
  .bundle-stats { display: grid; grid-template-columns: repeat(4, max-content); align-items: center; gap: .45rem 1.1rem; min-width: 0; }
  .metric { display: inline-flex; align-items: center; gap: .3rem; min-width: 0; white-space: nowrap; }
  .metric svg { flex: 0 0 auto; width: .85rem; height: .85rem; margin-right: .1rem; color: var(--muted); }
  .metric strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: .72rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .metric span { color: var(--muted); font-size: .7rem; }
  .mode-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .45rem; padding: .7rem .9rem .85rem; }
    .mode-option { display: grid; gap: .25rem; min-width: 0; padding: .55rem .6rem; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); background: var(--bg); text-align: left; }
    .mode-title { display: flex; align-items: center; gap: .35rem; min-width: 0; }
    .mode-title svg { width: .95rem; height: .95rem; flex: 0 0 auto; color: var(--muted); }
    .mode-option strong { color: var(--text); font-size: .75rem; font-weight: 600; }
  .mode-option span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .63rem; }
  .mode-option.active { border-color: rgb(from var(--accent) r g b / .55); background: rgb(from var(--accent) r g b / .1); }
    .mode-option.active strong, .mode-option.active .mode-title svg { color: var(--accent); }
  .subtype-wrap { border-top: 1px solid var(--border); background: rgb(from var(--accent) r g b / .025); }
  .subtype-options { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .45rem; padding: .7rem .9rem .45rem; }
  .report-subtypes { grid-template-columns: repeat(2, minmax(0, 1fr)); padding-bottom: .7rem; }
  .subtype-option { display: grid; gap: .12rem; padding: .42rem .55rem; border: 1px solid var(--border); border-radius: 5px; color: var(--muted); background: var(--bg); text-align: left; }
  .subtype-option strong { color: var(--text); font-size: .72rem; font-weight: 500; }
  .subtype-option span { font-size: .62rem; }
  .subtype-option.active { border-color: rgb(from var(--accent) r g b / .55); background: rgb(from var(--accent) r g b / .1); }
  .subtype-option.active strong { color: var(--accent); }
  .subtype-help { margin: 0; padding: .15rem .9rem .72rem; color: var(--muted); font-size: .68rem; line-height: 1.4; }
  .source-choice { display: grid; grid-template-columns: minmax(12rem, .8fr) minmax(16rem, 1.2fr); gap: .7rem; align-items: end; padding: .85rem .9rem; }
  .source-footer { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: .7rem 1rem; grid-column: 1 / -1; min-width: 0; }
  /* Reserve the scope control's footprint while metadata is being read. */
  .scope-slot { justify-self: end; width: min(34rem, 100%); min-height: 2rem; }
  .source-footer .bundle-stats { min-height: 2rem; }
  .choice-empty { display: flex; align-items: center; height: 2rem; padding: .28rem .5rem; border: 1px dashed var(--border); border-radius: 5px; color: var(--muted); background: var(--bg); font-size: .72rem; }
  .scope-head { display: flex; align-items: center; gap: .55rem; padding: .72rem .9rem; list-style: none; cursor: default; user-select: none; }
  .scope-head::-webkit-details-marker { display: none; }
  .scope-head:hover { background: var(--surface-active); }
  .scope-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; border-radius: 8px; }
  .scope-chevron { width: .85rem; height: .85rem; flex: 0 0 auto; transition: transform .15s; }
  .scope-panel[open] .scope-chevron { transform: rotate(90deg); }
  .scope-panel[open] .scope-head { border-bottom: 1px solid var(--border); }
  .scope-head h2 { margin: 0; font-size: .86rem; font-weight: 600; }
  .scope-head p { display: flex; flex-wrap: wrap; justify-content: end; gap: .15rem .65rem; margin: 0 0 0 auto; color: var(--muted); font-size: .7rem; font-variant-numeric: tabular-nums; text-align: right; }
  .scope-head p span { white-space: nowrap; }
  .scope-head p span + span { padding-left: .65rem; border-left: 1px solid var(--border); }
  .scope-grid { display: grid; grid-template-columns: minmax(13rem, .75fr) minmax(0, 1.25fr); min-height: 0; }
  .scope-pane { min-width: 0; }
  .scope-pane + .scope-pane { border-left: 1px solid var(--border); }
  .pane-head { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; padding: .55rem .75rem; border-bottom: 1px solid var(--border); }
  .pane-head strong { font-size: .72rem; font-weight: 600; }
  .pane-head span { color: var(--muted); font-size: .65rem; font-variant-numeric: tabular-nums; }
  .package-list { max-height: 22rem; overflow: auto; overscroll-behavior: none; }
  .package-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .45rem; width: 100%; padding: .42rem .7rem; border: 0; border-bottom: 1px solid var(--border); color: var(--text); background: transparent; text-align: left; }
  .package-row:hover { background: var(--surface-active); }
  .package-row input, .file input { width: .85rem; height: .85rem; accent-color: var(--accent); }
  .package-name, .package-size { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .package-name { font-size: .7rem; }
  .package-size { color: var(--muted); font-size: .64rem; font-variant-numeric: tabular-nums; }
  .package-row.excluded .package-name { color: var(--muted); text-decoration: line-through; }
  .file-panel { min-width: 0; }
  .file-list { display: grid; grid-template-columns: minmax(0, 1fr); max-height: 22rem; overflow: auto; overscroll-behavior: none; }
  .file { display: flex; align-items: center; gap: .45rem; min-width: 0; padding: .35rem .75rem; border-bottom: 1px solid var(--border); }
  .file input { flex: 0 0 auto; }
  .file-copy { display: flex; align-items: center; gap: .75rem; flex: 1; min-width: 0; }
  .file-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .72rem; }
  .file-meta { flex: 0 1 auto; min-width: 0; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: .66rem; font-variant-numeric: tabular-nums; }
  .excluded .file-path { color: var(--muted); text-decoration: line-through; }
  .file-foot { display: flex; justify-content: space-between; gap: .6rem; padding: .6rem .8rem; color: var(--muted); font-size: .7rem; }
  .options { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 1rem; position: relative; z-index: 2; overflow: visible; padding: .85rem .9rem 1rem; }
  .options-grid { display: grid; grid-column: 1 / -1; gap: .7rem; min-width: 0; }
  .checks { position: relative; display: grid; grid-column: 2; grid-row: 3; align-content: center; justify-items: end; margin-top: 1rem; }
  .offline-help { position: absolute; top: calc(50% + .75rem); right: 0; color: var(--muted); font-size: .66rem; line-height: 1.4; white-space: nowrap; }
  .check { display: inline-flex; align-items: center; gap: .4rem; color: var(--text); font-size: .75rem; }
  .check input { width: .85rem; height: .85rem; accent-color: var(--accent); }
  .switch { display: inline-flex; align-items: center; gap: .45rem; color: var(--text); font-size: .74rem; cursor: default; }
  .switch input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .switch-track { position: relative; width: 2rem; height: 1.1rem; border-radius: 999px; background: var(--surface-active); transition: background .12s; }
  .switch-track::after { content: ''; position: absolute; top: .15rem; left: .15rem; width: .8rem; height: .8rem; border-radius: 50%; background: var(--muted); transition: transform .12s, background .12s; }
  .switch input:checked + .switch-track { background: rgb(from var(--accent) r g b / .4); }
  .switch input:checked + .switch-track::after { transform: translateX(.9rem); background: var(--accent); }
  .checks .switch input:checked + .switch-track { background: rgb(from var(--critical, #e5534b) r g b / .3); }
  .checks .switch input:checked + .switch-track::after { background: var(--critical, #e5534b); }
  .switch input:focus-visible + .switch-track { outline: 2px solid var(--accent); outline-offset: 2px; }
  .options-footer { display: flex; flex-wrap: wrap; grid-column: 1; grid-row: 3; align-items: end; gap: .7rem; min-width: 0; margin-top: 1rem; }
  .options-footer slot[name=before-run] { display: contents; }
  .agentic-fields { display: grid; gap: .65rem; padding: .85rem .9rem 1rem; }
  .agentic-panel .panel-head { align-items: center; }
  .prompt-row { display: flex; align-items: start; gap: .4rem; min-width: 0; }
  .prompt-row textarea { flex: 1; width: 0; }
  .prompt-action { display: grid; place-items: center; flex: 0 0 auto; width: 1.5rem; height: 1.5rem; padding: .25rem; border: 0; border-radius: 4px; color: var(--muted); background: transparent; }
  .prompt-action:hover { color: var(--text); background: var(--surface-active); }
  .prompt-action svg { width: 1rem; height: 1rem; fill: none; stroke: currentColor; stroke-width: 1.4; }
  textarea { min-width: 0; resize: vertical; padding: .4rem .5rem; border: 1px solid var(--border); border-radius: 5px; color: var(--text); background: var(--bg); font: inherit; font-size: .76rem; }
  .run { padding: .48rem .8rem; border: 0; border-radius: 6px; color: var(--bg); background: var(--accent); font-size: .8rem; font-weight: 600; }
  .run:disabled { opacity: .45; }
  .summary { align-self: end; padding-block: .48rem; color: var(--muted); font-size: .74rem; }
  .history { display: grid; gap: .6rem; }
  .scan-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 1rem; padding: .85rem .9rem; }
  .scan-row + .scan-row { border-top: 1px solid var(--border); }
  .scan-main { min-width: 0; }
  .scan-title { display: flex; align-items: center; gap: .45rem; min-width: 0; }
  .scan-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .82rem; }
  .scan-meta { display: block; margin-top: .25rem; color: var(--muted); font-size: .7rem; }
  .status { display: inline-flex; align-items: center; gap: .3rem; padding: .15rem .4rem; border-radius: 999px; font-size: .66rem; font-weight: 600; text-transform: capitalize; }
  .status::before { content: ''; width: .4rem; height: .4rem; border-radius: 50%; background: currentColor; }
  .status.running { color: var(--accent); background: rgb(from var(--accent) r g b / .1); }
  .status.completed { color: #48b878; background: rgb(72 184 120 / .1); }
  .status.stopped { color: var(--muted); background: var(--surface-active); }
  .scan-actions { display: flex; align-items: center; gap: .45rem; }
  .action { padding: .35rem .55rem; border: 1px solid var(--border); border-radius: 5px; color: var(--text); background: var(--bg); font-size: .72rem; white-space: nowrap; }
  .action:hover { border-color: var(--muted); background: var(--surface-active); }
  .empty { margin: 0; padding: 1.2rem; color: var(--muted); font-size: .8rem; }
  @container scan-page (max-width: 48rem) { .bundle-choice, .source-choice, .source-footer { grid-template-columns: 1fr; gap: .7rem; } .scope-grid { grid-template-columns: 1fr; } .scope-pane + .scope-pane { border-top: 1px solid var(--border); border-left: 0; } }
  @container scan-page (max-width: 42rem) { .options { display: block; padding-bottom: 3rem; } .checks { margin-top: .8rem; } .offline-help { max-width: 100%; white-space: normal; } .options-footer { margin-top: .8rem; } }
  @container scan-page (max-width: 34rem) { .mode-grid, .subtype-options { grid-template-columns: 1fr 1fr; } .bundle-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .45rem .65rem; } .scope-head { flex-wrap: wrap; } .scope-head p { flex-basis: 100%; justify-content: start; margin-left: 1.4rem; text-align: left; } .scope-head p span { white-space: normal; } .scope-head p span + span { padding-left: 0; border-left: 0; } .scan-row { grid-template-columns: 1fr; gap: .55rem; } .scan-actions { justify-content: flex-start; } .head-tabs { margin-left: 0; } }
`
