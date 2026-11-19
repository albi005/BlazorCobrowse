# BlazorCobrowse

Cobrowsing for Blazor Server applications. A tenant app embeds a small plugin;
the customer clicks **Request remote support**; an agent accepts the request in
a console and sees the customer's page as a live DOM mirror, with optional
control.

```
User browser ──► Tenant app (App) ──► Cobrowse service ──► Agent console
      │                 │                     │
      └──── SignalR hub ┘                     └── rrweb stream / control
```

## Projects

| Project | Purpose |
| --- | --- |
| `src/App` | Sample Blazor Server tenant app. Shows the drop-in plugin. |
| `src/App.Cobrowse` | The plugin: support button, HTTP client, browser capture, banner. |
| `src/CobrowseService` | The cobrowse service: tenant API, SignalR hub, agent console. |

## Run it

```bash
dotnet run --project src/CobrowseService --urls http://localhost:5232
dotnet run --project src/App --urls http://localhost:5010
```

Open <http://localhost:5010>, click **Request remote support**, then open
<http://localhost:5232/agent> and accept the request.

### Try it from a phone (Tailscale)

Both apps also listen on the Tailscale interface. With the phone on the same
tailnet, open:

- Tenant app: <http://100.69.0.1:5010>
- Agent console: <http://100.69.0.1:5232/agent>

The sample configuration points `ServiceBaseUrl`, `PublicHubUrl`,
`PublicBaseUrl` and `AllowedOrigins` at `100.69.0.1`. If your Tailscale IP
changes, update those values in `src/App/appsettings.json` and
`src/CobrowseService/appsettings.json` and restart both apps.

The sample configuration uses:

- tenant `demo` with key `dev-tenant-key`
- a development agent (`agent-1` / `Support Agent`)
- the service at `http://localhost:5232`

## How it works

1. The plugin calls `POST /api/v1/support-requests` on the service from the
   tenant server, authenticated with the tenant key. The response contains a
   short-lived join token and the hub URL.
2. The customer's browser connects to the hub and joins with that token. rrweb
   records the DOM and sends batched events.
3. An agent accepts the request. The service mints an agent ticket; the agent
   console joins the same hub group and receives the backlog plus live events.
4. The agent's mirror is rebuilt from rrweb events. Clicks focus the real
   element; keystrokes, caret keys (arrows/Home/End/Backspace/Delete), Ctrl+A,
   pastes and a dropdown's chosen option are forwarded to the customer and
   applied there. Agent scrolling is sent as **relative deltas** (`scrollBy`),
   not absolute positions, so the two sides cannot fight over the offset.
5. Either side can end the session. The service revokes tickets and notifies
   both sides.

The mirror renders at the customer's native viewport size, without scaling.
Scroll sync is the most delicate part of the system; see
[docs/scroll-sync.md](docs/scroll-sync.md) for the protocol, the gesture
handling and the echo-suppression rules.

## Configuration

`src/CobrowseService/appsettings.json`:

```json
{
  "Cobrowse": {
    "PublicBaseUrl": "http://localhost:5232",
    "AllowedOrigins": [ "http://localhost:5010" ]
  },
  "Tenants": {
    "Tenants": {
      "demo": { "ApiKey": "dev-tenant-key", "DisplayName": "Demo tenant" }
    }
  },
  "Agent": { "Id": "agent-1", "DisplayName": "Support Agent" }
}
```

`src/App/appsettings.json`:

```json
{
  "Cobrowse": {
    "ServiceBaseUrl": "http://localhost:5232",
    "TenantId": "demo",
    "ApiKey": "dev-tenant-key",
    "PublicHubUrl": "http://localhost:5232/hubs/cobrowse",
    "AllowControl": true
  }
}
```

## Authentication

The seams are in place but the implementations are development placeholders:

- **Customers** are read from the tenant app's `ClaimsPrincipal` by
  `ICobrowseUserProvider`. Wire Google SSO into the tenant app and the default
  `ClaimsCobrowseUserProvider` picks up the standard OIDC claims.
- **Agents** are read by `IAgentIdentityProvider`. Today it uses the configured
  development agent, or claims if an upstream authenticates the request. Replace
  it with LDAP/OIDC without touching the hub or the console.
- **Tenants** authenticate with a shared key in `TenantDirectory`. The tenant
  service and cobrowse service are expected to share a private network; replace
  the key with mTLS or a signed service token later.

## Versioning

Tenant instances may run different plugin versions. The HTTP contract is
versioned by path (`/api/v1`), the hub contract by the `protocol` field on join,
and the plugin reports its version in `X-Cobrowse-Client`. See
[docs/compatibility.md](docs/compatibility.md).

## Verifying

Three end-to-end suites drive real sessions in headless Chromium:

```bash
cd scripts
npm install          # once; playwright is not committed
node verify-scroll-sync.js    # both scroll directions, wobble, cursor, sizing
node verify-input-sync.js     # typing, caret, select, no auto-scroll
node verify-interactions.js   # every control both ways, cursor, inner scroll
```

They need both servers running. Set `APP_URL`, `AGENT_URL` or `CHROMIUM_PATH`
to override the defaults, or `HEADLESS=false` to watch. Each script exits
non-zero on failure.

`d320572` is the verified stable baseline; the tag `stable-sync-2026-11-19`
marks it. See [docs/handoff.md](docs/handoff.md#stable-baseline) for how to
compare or return to it.

## Handoff

[docs/handoff.md](docs/handoff.md) records the current state, how to run and
verify everything, the known limitations and the next steps. Start there when
picking the work up.

## Future work

- Screen-sharing fallback when rrweb cannot capture a page.
- RustDesk integration for full remote control.
- ~~redis-backed request store and SignalR backplane for scale-out.~~ not needed
