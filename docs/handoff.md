# Handoff

State of the cobrowsing work as of the scroll-sync fixes. Read this first, then
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
- Clicks and `setValue` from the mirror reach the customer's DOM.
- The sample app has interactive controls (input, textarea, select, checkbox,
  radio, range, list, submit summary) plus scroll-test filler.

Verified with `scripts/verify-scroll-sync.js` across three viewport pairings:
same size, agent smaller than customer, agent larger than customer. All checks
pass with no console errors.

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
```

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

## PoC reference

The original OpenReplay PoC is at
`~/.t3/scratch/2026-11-17-hi-investigate-openreplay-i-need-9ec5f306/CobrowseDemo`.
It is the source of the relative-scroll and native-size decisions. Consult it
before changing the scroll model; it is easy to reintroduce the absolute-position
echo loop.
