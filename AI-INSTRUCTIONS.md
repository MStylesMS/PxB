# Paradox Bridge (PxB) — AI Instructions

PxB is a **Node.js MQTT bridge** that owns all direct-hardware integrations on a Paradox host:
- **Z-Wave / Zigbee / Thread radios** (sole owner of radio serial ports)
- **Philips Hue** smart lights (Hue REST v2 API via a local Hue bridge)
- **WiZ** smart bulbs (UDP, LAN-direct, no cloud)
- **LIFX** smart lights (LIFX Cloud API)
- **Shelly** relays (HTTP Gen 2)
- **DMX512** fixtures via OpenDMX or Enttec USB Pro

It exposes a simple, stable MQTT contract for all other Paradox components so that PFx, PxO, and operator UIs never reach hardware directly.

## Tech Stack

- **Runtime**: Node.js 18+
- **Z-Wave**: `zwave-js`
- **Zigbee (planned)**: `zigbee-herdsman`
- **Thread (future)**: TBD
- **Philips Hue**: Hue REST v2 API (local bridge, HTTP)
- **WiZ**: UDP datagram packets direct to bulb IPs
- **LIFX**: LIFX Cloud REST API (requires API token)
- **Shelly**: HTTP Gen 2 REST API
- **DMX**: `@node-dmx` (OpenDMX) / Enttec USB Pro serial protocol
- **Config**: INI format with `[mqtt]`, `[global]`, `[zwave]`, `[zigbee]`, `[light:<name>]`, `[light-zone:<name>]`, `[switch:<name>]`, `[effect:<name>]` sections
- **Transport**: MQTT (shared `paradox/...` topic tree)
- **Platforms**: Raspberry Pi 3/4/5, desktop Linux

## Architecture Summary

PxB runs as a single process that manages one or more radios on a single host. Each configured node gets a per-node base topic (operator-defined in INI) and publishes retained `events` and `state` messages. The bridge process publishes retained lifecycle heartbeats on `state` (default 10s) so Web UIs can monitor bridge health. A `commands` topic accepts pairing control, relay output, and diagnostic commands; the same operations are available via a CLI (`pzb`).

## Paradox Family Context

PxB is one of the Paradox products. It is designed to **replace direct radio handling in PFx** — PFx consumes PxB over MQTT like any other zone. Family:

- **PFx** — media/audio/lights/relays controller (Node.js)
- **PxO** — game orchestration engine (Node.js, EDN)
- **PxC** — configurable clock apps (React build system)
- **PxT** — player terminal kiosk (Electron)
- **Pio** — GPIO-to-MQTT bridge (C++)
- **PxB** — this project, radio-to-MQTT bridge (Node.js)
- **PxP** — Paradox Prime operator/admin hub (configures & manages this app; not part of a running game)

## Critical Constraints

- **MQTT topic structure is sacred**: `{baseTopic}/{commands|events|state|warnings}`
- **Per-node base topic is operator-defined** in INI — PxB does not force a fixed `<base>/zwave/<nodeid>/…` tree
- **Retention rules**:
  - Bridge state/lifecycle heartbeat: retained, periodic (default 10s)
  - Node events: retained, on-change only
  - Node state: retained, on-change only
- **Event payload must match the PFx InputZone contract**: `{input, event, source: "zwave-node-<n>"|"zigbee-<ieee>", ts, raw}`
- **Single-writer to radio**: PxB is the only process that opens the radio serial port. PFx direct-radio backends must be retired as PxB comes online.
- **Discovered-but-unconfigured nodes** get a generated INI fragment with placeholders — PxB does not silently start publishing under a guessed topic without operator confirmation (except under a clearly marked `discovered/` prefix).
- **Generic light zones stay generic**: mixed-vendor `[light-zone:*]` groups are allowed. Do not add vendor-specific grouping layers unless the hardware contract truly requires them.
- **Best-effort light capability handling**: adapters should apply the parts of a light command they support and publish a warning when asked for an unsupported capability. Do not block mixed-vendor grouping on cross-backend normalization work.
- **Do not leave dormant feature scaffolding**: if passthrough routing or aggregator behavior is not shipping, remove the dead code/docs instead of parking half-wired abstractions in the repo.
- **Adapters must use `safeCall` for async surfaces.** Every `setInterval`, `setTimeout`, and MQTT `subscribe` callback inside `src/lights/`, `src/switches/`, and `src/radios/*/events.js` must go through `AdapterBase.safeCall(label, fn)`. Bare timers/listeners in those paths are blocked by an ESLint `no-restricted-syntax` rule. If you need a bare timer for a good reason (e.g. a promise-wrapping delay), add an `// eslint-disable-next-line no-restricted-syntax -- <reason>` comment.
- **New adapters require `_subsystemId` and registry registration.** Before calling `adapter.init()` from `src/index.js`, set `adapter._subsystemId = '<kind>-<label>'` and wire an `onCrash` handler in `src/index.js` that registers the subsystem with `SubsystemRegistry`. Do not skip this for any new adapter.
- **`SubsystemRegistry` is the single crash containment point.** Do not add parallel try/catch error-routing, custom error-handling timers, or custom re-registration logic outside `src/bridge/subsystem-registry.js`. All crash budget and cooldown logic lives there.

## Documentation-First Development

Before significant changes, review [docs/SPEC.md](docs/SPEC.md) and [docs/MQTT_API.md](docs/MQTT_API.md). If a change conflicts with documented design, propose doc updates first. Update docs alongside code. API/protocol changes require explicit approval. Use commit prefixes: `Docs:`, `Implement:`, `Fix:`, `Test:`, `Refactor:`, `Chore:`.

## Key References

| Document | Purpose |
|----------|---------|
| [AI-DETAILED-OVERVIEW.md](AI-DETAILED-OVERVIEW.md) | Full architecture, module layout, lifecycle, pairing FSM, normalization rules |
| [docs/SPEC.md](docs/SPEC.md) | Functional specification |
| [docs/MQTT_API.md](docs/MQTT_API.md) | MQTT contract (commands, events, state, status, warnings) |
| [docs/CONFIG_INI.md](docs/CONFIG_INI.md) | INI configuration reference |
| [docs/QUICK_START.md](docs/QUICK_START.md) | Install / first run |
| [docs/PR_PZB_INITIAL.md](docs/PR_PZB_INITIAL.md) | Phased implementation plan |
| [README.md](README.md) | User-facing overview |
| [docs/PR_FAULT_ISOLATION.md](docs/PR_FAULT_ISOLATION.md) | Subsystem fault isolation design — crash budget, cooldown, quarantine |
| Parent system: [/opt/paradox/AI-INSTRUCTIONS.md](/opt/paradox/AI-INSTRUCTIONS.md) | System-wide context (when present) |
