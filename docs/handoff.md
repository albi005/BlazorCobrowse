# Handoff

State of the cobrowsing work as of the input-sync changes. Read this first, then
[docs/scroll-sync.md](scroll-sync.md) for the scroll design.

## What this is

Cobrowsing for Blazor Server. A tenant app embeds a plugin; the customer asks
for help; an agent accepts in a console and sees a live DOM mirror with optional
control. Three projects:

| Project | Role |
| --- | --- |
| `src/App` | Sample Blazor Server tenant app (namespace `SampleApp`) |
| `src/App.Cobrowse` | Drop-in plugin: support button, HTTP client, rrweb capture, banner, control application |
| `src/CobrowseService` | Service: tenant API, SignalR hub, agent console, rrweb relay |

Flow: `User → Tenant app → Cobrowse service → Agent console`.

## Current state

Working and verified end to end:

- Customer requests support; the agent console lists the request; accepting
  gives the agent a live rrweb mirror and view consent.
- Customer → agent scroll sync.
- Agent → customer scroll sync via the "Scroll down" button and mouse wheel.
- No wobble after an agent gesture settles.
- The mirror renders at the customer's native viewport size (no scaling).
- Cursor dot is anchored to document coordinates and stays under the agent's
  pointer while the document scrolls.
- Clicks and `setValue` (the "Send text" toolbar) from the mirror reach the
  customer's DOM.
- Typing in a mirror field is forwarded as keystrokes, the same model as the
  screen-sharing PoC: a click focuses the customer's real element and puts the
  caret at the end, then text, Backspace/Delete, arrows, Home/End, Ctrl+A,
  Enter and paste are applied there. A red ring shows the customer which
  element the agent is working in. Typing mirrors live because rrweb records
  `input` (sampling `input: 0`), not just `change`. A dropdown opens its native
  popup in the mirror; the chosen option is forwarded to the customer's
  `<select>`. A range stays native too (the thumb follows the agent's pointer)
  and its value is forwarded, coalesced to one update per 40ms.
- Every sample control round-trips in both directions: counter buttons and
  Reset, checkbox, radio, select, range, name/notes typing, list add/remove,
  Submit feedback and the "Send text" toolbar. `scripts/verify-interactions.js`
  asserts the customer state and the mirrored state after each action.
- The sample app has interactive controls (input, textarea, select, checkbox,
  radio, range, list, submit summary) plus scroll-test filler.

Verified end to end: `verify-scroll-sync.js` across three viewport pairings
(same size, agent smaller, agent larger), `verify-input-sync.js` for typing and
`verify-interactions.js` for every control in both directions. All checks pass
with no console errors.

## Running it

```bash
dotnet run --project src/CobrowseService --urls "http://100.69.0.1:5232;http://localhost:5232"
dotnet run --project src/App --urls "http://100.69.0.1:5010;http://localhost:5010"
```

- Tenant app: <http://100.69.0.1:5010>
- Agent console: <http://100.69.0.1:5232/agent>
- Service: <http://100.69.0.1:5232>

Both bind to the Tailscale interface so a phone on the same tailnet can test.
If the Tailscale IP changes, update `src/App/appsettings.json` and
`src/CobrowseService/appsettings.json` (`ServiceBaseUrl`, `PublicHubUrl`,
`PublicBaseUrl`, `AllowedOrigins`) and restart.

Development identities:

- Tenant `demo`, key `dev-tenant-key`.
- Agent `agent-1` / `Support Agent`.
- The sample app has no SSO wired, so the customer is `anonymous` /
  `Unknown user`. `ClaimsCobrowseUserProvider` already reads standard OIDC
  claims; wiring Google SSO is configuration plus an auth handler, not a
  plugin change.

## Verifying scroll sync

```bash
cd scripts
npm install          # once; playwright is not committed
node verify-scroll-sync.js
node verify-input-sync.js
node verify-interactions.js
```

`verify-input-sync.js` checks agent -> customer typing: click focus, live
binding, arrows and mid-field insertion, Ctrl+A, Backspace, Enter (input vs
textarea), select and the mirrored value. `verify-interactions.js` walks every
sample control in both directions (buttons, checkbox, radio, select, range,
list add/remove, submit, Send text). On NixOS the bundled Playwright Chromium
may lack system libraries; run them under `nix shell nixpkgs#chromium` and pass
`CHROMIUM_PATH=$(command -v chromium)`.

Environment overrides: `APP_URL`, `AGENT_URL`, `SERVICE_URL`, `TENANT_ID`,
`TENANT_KEY`, `CHROMIUM_PATH`, `HEADLESS=false` to watch. The script exits
non-zero if any check fails. It cleans up live requests through the tenant API
before and after each scenario.

The script checks:

- customer → agent scroll
- "Scroll down" button reaches both sides
- agent wheel reaches both sides
- the mirror holds still after the gesture settles (wobble regression)
- the cursor dot follows the document but stays under the pointer
- the mirror document matches the customer's viewport size
- no console errors

## Gotchas

- **One live request per user.** `SupportRequestService.CreateAsync` reuses the
  live request for the same user instead of creating a second one. A request
  left behind by a crashed run therefore shows up as an *active* session
  ("Open") instead of a new *pending* request ("Accept"), and the next test
  cannot start. End it in the console or cancel it:

  ```bash
  curl -s http://100.69.0.1:5232/api/v1/agent/queue
  curl -s -X POST \
    -H 'X-Cobrowse-Tenant: demo' -H 'X-Cobrowse-Key: dev-tenant-key' \
    http://100.69.0.1:5232/api/v1/support-requests/<id>/cancel
  ```

- **Static assets and `--no-build`.** JS/CSS under `wwwroot` is served from the
  source tree in Development, so a running `--no-build` process picks up edits
  after a hard refresh. C# changes need a rebuild and restart.
- **Hard-refresh both pages** after changing the JS. The agent console caches
  `cobrowse-agent.js` aggressively.
- **The mirror iframe, not the wrapper.** When the customer's page is narrower
  than the agent's panel, the wrapper is much wider than the iframe. Hovering
  or wheeling over the empty wrapper area does nothing. The verify script picks
  a point inside the iframe.
- **Mirror caret is cosmetic.** rrweb's `applyInput` sets the mirror input's
  value, which resets that input's caret to the end. The customer's caret is
  authoritative, so mid-field edits still land in the right place; the mirror
  may show the caret at the end.
- **Text fields and selects.** `key`/`paste` drive `<input>` and `<textarea>`.
  A `<select>` opens its native popup in the mirror (the click is not
  intercepted) and its `change` is forwarded as a value, including
  multi-select. `contenteditable`, cross-origin iframes and file pickers are
  still click-only. Ctrl+C / Ctrl+X stay local to the agent's mirror; Ctrl+V
  forwards the agent's clipboard text.
- **Hidden tabs throttle the batcher.** Browsers clamp a hidden/occluded tab's
  60ms timers to ~1s, which made agent feedback look like a one-second round
  trip. `queueEvent` now flushes from a microtask (not throttled) when
  `document.hidden`, and `visibilitychange` flushes any pending batch. If
  feedback is slow, check whether the customer window is fully behind another
  window. Visible tabs batch at `FLUSH_INTERVAL_MS` (60ms).
- **Background logs** from the long-running dev servers, if still present:
  `/tmp/opencode/cobrowse-app.log`, `/tmp/opencode/cobrowse-service.log`.

## Next steps

Ordered by likely value:

1. **Inner scroll containers.** The gesture handlers use
   `document.scrollingElement`; a wheel over a scrollable `<div>` scrolls the
   page. Resolve the nearest scrollable ancestor from `event.target`, send its
   `data-cb-id` as `nodeId`, and keep the same relative-delta protocol. The
   customer already applies `nodeId` scrolls to the element.
2. **Phone testing.** Hard-refresh both pages on the phone and confirm wheel,
   touch drag, and the "Scroll down" button. Touch is driven manually in the
   mirror, so it is the most likely place for a new mismatch.
3. **Google SSO for customers** and **LDAP for agents.** The seams are
   `ICobrowseUserProvider` and `IAgentIdentityProvider`; the hub, console, and
   plugin do not need changes.
4. **Tenant/service trust.** The shared key in `TenantDirectory` is a
   development placeholder. Replace with mTLS or a signed service token.
5. **Screen-sharing fallback** when rrweb cannot capture a page, and
   **RustDesk** integration for full remote control. Both are future work and
   not started.

## Key files

| File | What lives there |
| --- | --- |
| `src/CobrowseService/wwwroot/js/cobrowse-agent.js` | Agent session, mirror, gesture handling, scroll merging, echo suppression, cursor |
| `src/App.Cobrowse/wwwroot/js/cobrowse-capture.js` | rrweb capture, control application, relative scroll, cursor dot |
| `src/App.Cobrowse/wwwroot/js/cobrowse-client.js` | Customer SignalR connection and banner |
| `src/CobrowseService/Realtime/CobrowseHub.cs` | Hub: join, backlog, control/cursor forwarding, consent |
| `src/CobrowseService/Contracts/WireContract.cs` | Hub/HTTP payloads, protocol constants |
| `src/CobrowseService/Sessions/SupportRequestService.cs` | Request lifecycle, one-live-request rule, consent |
| `src/CobrowseService/Components/Pages/AgentConsole.razor` | Queue, accept, mirror, scroll-down button |
| `src/App/Components/Pages/Home.razor` | Sample app controls and scroll-test filler |
| `src/App.Cobrowse/CobrowseSession.cs` | Plugin lifecycle and module loading |
| `docs/scroll-sync.md` | Scroll design and invariants |
| `docs/compatibility.md` | Versioning rules for independently deployed tenants |
| `scripts/verify-scroll-sync.js` | End-to-end scroll/cursor check |
| `scripts/verify-input-sync.js` | End-to-end agent -> customer input check |
| `scripts/verify-interactions.js` | Every sample control, both directions |

## PoC reference

The original OpenReplay PoC is at
`~/.t3/scratch/2026-11-17-hi-investigate-openreplay-i-need-9ec5f306/CobrowseDemo`.
It is the source of the relative-scroll and native-size decisions. Consult it
before changing the scroll model; it is easy to reintroduce the absolute-position
echo loop.
