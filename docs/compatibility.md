# Compatibility

Tenant applications and the cobrowse service are deployed independently. A
tenant may run an older plugin for weeks after the service is upgraded, so both
sides follow these rules.

## HTTP

- The contract lives under `/api/v1`. A breaking change gets a new path
  (`/api/v2`); v1 handlers stay alive while any tenant still uses them.
- Within a version, changes are additive only. Never rename or remove a
  property.
- Unknown JSON properties are ignored on both sides, so a newer peer's extra
  fields are harmless.
- The plugin sends `X-Cobrowse-Protocol` and `X-Cobrowse-Client`
  (`Product/Version; protocol=N`). The service rejects a request outside its
  supported range with `426 Upgrade Required` and a `minSupported` /
  `maxSupported` body.

## Hub

- The customer sends `protocol` and `minProtocol` on `JoinAsCustomer`. The
  service rejects a protocol outside `Cobrowse:MinHubProtocol` ..
  `Cobrowse:MaxHubProtocol`.
- Capabilities are additive strings (`rrweb-v1`, `control-v1`,
  `resnapshot-v1`, `batch-v1`). The service only sends traffic a client has
  announced; an empty list means the protocol-1 baseline.
- Enumerations travel as strings. Receivers must tolerate values they do not
  know and treat an unknown terminal state as terminal, not as an error.
- Hub method names and message names are part of the contract. Add new methods
  and messages; do not rename existing ones.

## Version reporting

`Directory.Build.props` sets one `CobrowseVersion` for the product. The plugin
reports it on every tenant request and hub join, and the service stores the
customer's client string on the request. The agent console shows it in the
session header, which makes it possible to tell which tenant build a customer
is running.
