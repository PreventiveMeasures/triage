# Shared Scans page

`deepview-scan-page` renders scan settings without owning app navigation or
fetching a bundle catalogue. Its host supplies:

- `source`: bundle, repository, and scan-history arrays
- `loadBundle(bundle, signal)`: optional lazy loader for a bundle’s files and scopes
- `loadModels(signal)`: model catalogue loader
- `canRun`: host-controlled access gate (defaults to true for managed Scans)
- `loadReportSources(signal)`: separate Merge bundle/results and Link scope/report catalogues
- `navigation` slot: the host’s breadcrumb or Home button
- `access` slot: the host's optional access controls, above the scan options
- `before-run` slot: extra controls before Run scan

The host also supplies the outer page gutters. Scope appears below the bundle
selector when the bundle has named scopes. When every scope is recognized,
it uses one-click options ordered All files, metro, run, add (only available
scopes are shown). The selected option describes its contents to the left;
run says “Bundler and Node.js CLI” alongside metro, or “Node.js CLI” without it.
Custom scopes keep the dropdown. Source filter starts collapsed and
keeps the included file/package counts, size, and LoC visible in its summary.
Byte sizes use binary units (KiB, MiB, GiB). Bundle pickers share the searchable
selector and use the landing page's sourcemap and Stasis icons.
Code excludes entries whose format is `resource:base64` or `directory` before
building its file/package counts, source size/LoC estimates, Source filter,
largest-files list, and scan inputs. This uses format metadata from both fresh
and cached bundles. The bundle's archive size still describes the stored file.

The managed wrapper supplies the existing development fixtures and managed
model transport. The local/E2E wrapper lists saved bundles from browser storage,
then uses the existing bundle metadata cache to load the selected bundle’s files,
sizes, source-line counts, packages, and scopes. LoC uses the same source-line
counting as the bundle overview and excludes resources. Stored bundles currently have no repository
assignment, so they appear as Unattached. Local scan history starts empty.

## Reports and Advanced Code scans

Reports has two independent input flows. **Merge** selects a bundle and its
scan-server results, including results that have never been saved. The managed
stub server supplies examples at `/api/admin/scan-results`; local/E2E supplies
an empty catalogue until result discovery is implemented.

**Link** selects saved reports by workspace or repository. Workspaces are only
available in local/E2E, using actual browser storage membership. Managed uses
visible reports with an assigned repository. Both apply the report library's
`isAppFinding` rule: a report must contain at least one application-layer finding.
Empty scopes are hidden, and a sole scope is selected automatically. Choosing a
scope selects all its reports; users can deselect any of them. Restarts preserve
the exact scope and selected IDs, intersected with the current catalogue.
Rows show app-finding counts, excluding source-only findings; deduplicated groups
count once. Future Link requests will contain a raw reports export, like workspace
export, filtered to app findings only. Export and submission are deliberately
not connected yet.

The standard Code depth selector uses List/Isolate segments with icons and a
sliding selection. Its description switches between “Regular scan depth” and
“Deeper search at ~10x the tokens spent” without changing the control's size.

Code's **Advanced** subtype edits one or more mode/model/effort/List-or-Isolate
regimes. Add regime copies the last row. Duplicate tuples remain editable and
are labeled; Run scan stays disabled until all rows are unique and the catalogue
is ready. The last row cannot be removed. Model/provider changes revalidate
unsupported model and effort values without deleting rows. Restarts retain the
whole regime list.
Modes use three stacked, single-click options; List/Isolate uses the shared depth
selector stacked vertically, without a subtitle. The angled
duplicate badge is positioned outside the row's layout so validation does not
resize the row. Remove controls sit in each row's top-right corner.

An **App model** disclosure sits below Add regime. It follows the common model
and effort while all regimes agree and shows both values in its collapsed
summary. Differences reveal the controls; users can also expand it manually.
An explicit app-model choice is independent of the scan regimes, remains valid
against the current catalogue, and is retained when restarting a run.

Agentic accepts multiple prompts. The header's + button adds a new agent prompt
and focuses it; additional fields can be removed. At least one field remains,
and restart restores the complete ordered prompt list.

## Local/E2E scan service

The shared Scans page is always included in the main UI bundle. The local/E2E
landing shows a Scan button when a runtime service is available:

- **E2E:** only discovery's `deepviewScanServer` field from `/api/config`
- **Local:** the development server's configuration, injected into its served
  HTML, or `http://127.0.0.1:3123/` when the page hostname is exactly `127.0.0.1`

`localhost` and other loopback addresses do not get the hostname fallback.
E2E never uses that fallback, even when opened on `127.0.0.1`.
The managed landing never gets this button.

`node --run serve` defaults to `http://127.0.0.1:3123/` and grants that origin
through its served HTML CSP. Override the dev service with:

```sh
DEEPVIEW_SCAN_SERVER=https://scan.example node --run serve
```

Production builds ignore `DEEPVIEW_SCAN_SERVER`; packaged `out/` stays the same
for every deployment. Configure the E2E server at **runtime**:

```sh
DEEPVIEW_SCAN_SERVER=https://scan.example node --run server
```

E2E defaults to an unset `deepviewScanServer` and a strict CSP. When configured,
it advertises the service through discovery and adds only that service's origin
to `connect-src` when serving HTML. The policy is the same on every hostname.
A fronting static host (including the dev proxy when backed by E2E) must allow
the scan-service origin advertised by the E2E server.

URL path prefixes are preserved in requests. The discovered service URL is
not persisted in the protocol cache; each page load discovers it again.

Local/E2E shows a built-in model catalogue before connecting, with Claude Opus
5.5 selected by default. GPT-6 Astra, Sol, and Luna each include a Pro variant,
shown as one family row with a Pro toggle in the selected model box.
No provider is selected initially. Selecting Anthropic limits the catalogue to
Claude models, OpenAI to GPT models, Moonshot to Kimi models, and OpenRouter
shows the full catalogue.
Moonshot uses provider ID `moonshot`; its model IDs retain `moonshotai/`.
The current model is preserved when available; otherwise the picker selects
the first model in the filtered catalogue.
Before connecting, effort controls use preview values. After connecting, models
and effort limits come from the scan service. Managed Scans continues to use its
own model transport.

The local/E2E Access group contains a DeepView API Key and Connect button, plus
a separate provider/token row with icon segments for Anthropic, OpenAI, Moonshot,
or OpenRouter. The segments form two rows on narrow screens. Connect requests
`{server}/api/models` with the DeepView key as Bearer authentication, initially
without a provider. Managed keys return their model catalogue and hide the
provider/token row. Non-managed keys validate first, then request
`?provider=...` for the selected provider and each subsequent provider change.
HTTP 401 disconnects with an unrecognized-key message. Editing the DeepView key
aborts in-flight requests and requires Connect again; late responses cannot
restore an old connection or catalogue. Run scan stays disabled until connected
with a loaded catalogue. Status appears in the Access header.
The previous model list stays visible while a replacement loads, starting with
the built-in defaults. Catalogue errors also leave the last choices in place;
access remains blocked until a request succeeds. Advanced rows stay visible
during catalogue refreshes.

Save appears on the right of that header when connected. It stores one JSON
object (`server`, `deepview`, `provider`, `token`) in `deepview.scan.access` through
secure storage, encrypted when the passkey vault is enabled. Forget remains
visible whenever saved credentials exist, even after disconnecting or editing
fields. Forget removes the saved entry, clears all access fields, and disconnects.
Opening Scans restores credentials only for the same service URL and
automatically connects. Later key edits still require pressing Connect again.
Unsaved credentials clear when leaving the page or changing
the discovered service. The saved entry participates in vault encryption
migration and wiping. Changing provider clears its token.
The isolated `scanServerRequest` transport omits cookies, rejects redirects,
and never uses the managed preview identity. Provider tokens are not sent by
model discovery.

Typing or pasting a provider token automatically selects Anthropic for
`sk-ant-`, OpenRouter for `sk-or-v1-`, Moonshot for `sk-kimi-`, or OpenAI for
`sk-proj-` / `sk-svcacct-`.
Detection starts as soon as a complete identifying prefix is entered, preserves
the token, and ignores surrounding whitespace. Incomplete or unrecognized
prefixes and generic `sk-` tokens leave the selection alone;
prefix detection does not validate credentials; it refreshes models only when
already connected with a non-managed key and the detected provider changes.
Moonshot platform keys use the ambiguous `sk-` prefix and require manual
selection. The distinctive `sk-kimi-` prefix belongs to Kimi Code credentials;
future connection support must route those to the Kimi Code endpoint, not the
Moonshot platform endpoint ([Kimi's credential documentation](https://www.kimi.com/code/docs/en/third-party-tools/hermes.html)).

Scan execution and report saving retain the existing UI prototype behavior;
they do not yet submit jobs or upload bundle contents to the service.
