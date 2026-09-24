# Shared Scans page

`deepview-scan-page` renders scan settings without owning app navigation or
fetching a bundle catalogue. Its host supplies:

- `source`: bundle, repository, report, and scan-history arrays
- `loadBundle(bundle, signal)`: optional lazy loader for a bundle’s files and scopes
- `loadModels(signal)`: model catalogue loader
- `navigation` slot: the host’s breadcrumb or Home button
- `access` slot: the host's optional access controls, above the scan options
- `before-run` slot: extra controls before Run scan

The host also supplies the outer page gutters. Scope appears below the bundle
selector when the bundle has named scopes. Source filter starts collapsed and
keeps the included file/package counts, size, and LoC visible in its summary.
Byte sizes use binary units (KiB, MiB, GiB). Bundle pickers share the searchable
selector and use the landing page's sourcemap and Stasis icons.

The managed wrapper supplies the existing development fixtures and managed
model transport. The local/E2E wrapper lists saved bundles from browser storage,
then uses the existing bundle metadata cache to load the selected bundle’s files,
sizes, source-line counts, packages, and scopes. LoC uses the same source-line
counting as the bundle overview and excludes resources. Stored bundles currently have no repository
assignment, so they appear as Unattached. Local report inputs and scan history
start empty.

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
The current model is preserved when available; otherwise the picker selects
the first model in the filtered catalogue.
The effort controls are preview values, not negotiated
service capabilities. Managed Scans continues to use its own model transport.

The local/E2E Access group contains a DeepView API Key and Connect button, plus
a separate provider/token row with icon segments for Anthropic, OpenAI, Moonshot,
or OpenRouter. The segments form two rows on narrow screens. Connect
currently reports that connections are unavailable; entering credentials does
not make requests. Both credentials remain in page memory and clear on leaving
the page, refreshing, or changing the discovered service. Changing provider
clears its token. The isolated `scanServerRequest` transport is available for
future connection work; it omits cookies, rejects redirects, and never uses
the managed preview identity.

Typing or pasting a provider token automatically selects Anthropic for
`sk-ant-`, OpenRouter for `sk-or-v1-`, Moonshot for `sk-kimi-`, or OpenAI for
`sk-proj-` / `sk-svcacct-`.
Detection starts as soon as a complete identifying prefix is entered, preserves
the token, and ignores surrounding whitespace. Incomplete or unrecognized
prefixes and generic `sk-` tokens leave the selection alone;
prefix detection does not validate credentials or make network requests.
Moonshot platform keys use the ambiguous `sk-` prefix and require manual
selection. The distinctive `sk-kimi-` prefix belongs to Kimi Code credentials;
future connection support must route those to the Kimi Code endpoint, not the
Moonshot platform endpoint ([Kimi's credential documentation](https://www.kimi.com/code/docs/en/third-party-tools/hermes.html)).

Scan execution and report saving retain the existing UI prototype behavior;
they do not yet submit jobs or upload bundle contents to the service.
