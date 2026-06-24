# PxB — AI Detailed Overview

This document expands on [AI-INSTRUCTIONS.md](AI-INSTRUCTIONS.md). Start there for context.

## Mission

Own the radio(s) on a Paradox Linux host and expose **events**, **state**, and **commands** for every configured node over MQTT, using a simple INI configuration model and a minimal CLI for provisioning.

## Non-Goals

- No web UI (Z-Wave JS UI already exists for power users; PxB is deliberately smaller).
- No deep automation/rules engine (PxO and PFx `input_map` cover this).
- No multi-radio-per-process beyond one Z-Wave endpoint + one Zigbee endpoint + (future) one Thread endpoint on the same host.
- No silent auto-publishing of unknown devices under arbitrary topics.

## Process Model

- **Single Node.js process** per host.
- Manages one Z-Wave driver (singleton on serial port) + one Zigbee coordinator (later) + (future) Thread.
- Supervised by systemd on Pi deployments. Dev runs via `node src/index.js`.

## High-Level Module Layout (Planned)

```
src/
  index.js               # entry point; arg parsing; supervisor loop
  config/
    ini-loader.js        # load/parse INI, validate, resolve per-node topics
    schema.js            # required/optional keys per section
  mqtt/
    client.js            # wrapper over mqtt lib (publish/subscribe + retained helpers)
    contract.js          # topic builders; payload shapes; retained policy
  bridge/
    bridge.js            # orchestrator: owns radios + node registry
    heartbeat.js         # bridge-level status publisher
    node-registry.js     # configured nodes + runtime state
    normalizer.js        # radio payloads → PxB normalized event/state
    subsystem-registry.js  # crash budget, cooldown, quarantine tracking per subsystem
    async-context.js       # AsyncLocalStorage wrapper: runInSubsystem / currentSubsystemId
  radios/
    zwave/
      driver.js          # zwave-js lifecycle (startup, interview, reconnect)
      events.js          # raw zwave-js events → normalizer
      commands.js        # setRelay, pulseRelay, refreshNode, removeFailedNode
      inclusion.js       # pairing FSM (startInclusion/stopInclusion/exclusion)
    zigbee/              # mirror of zwave/ (phase 3)
  cli/
    index.js             # `pzb` CLI entry
    commands/
      include.js
      exclude.js
      status.js
      relay.js
      dump-ini.js
  discovery/
    ini-generator.js     # build [node:<name>] INI fragment with placeholders
    discovered-store.js  # runtime store of discovered-but-unconfigured nodes
  util/
    logger.js
    ids.js
test/
  unit/
  fixtures/
```

## Config Model

One INI file per PxB process. Sections:

- `[mqtt]` — broker, port, credentials, base_topic, client_id
- `[global]` — log_level, heartbeat_interval (default 10s), discovered_base_topic (default `{base_topic}/pzb/discovered`)
- `[zwave]` — port (stable serial symlink), network_key (optional, s0/s2), enabled
- `[zigbee]` — port, adapter, db_path, enabled (phase 3)
- `[node:<label>]` — one per operator-named radio device:
  - `radio = zwave | zigbee`
  - `node_id = <int>` (Z-Wave) **or** `ieee = 0x...` (Zigbee)
  - `type = contact | motion | relay | switch | dimmer | custom`
  - `base_topic = paradox/<room>/zwave/<label>` (fully operator-controlled)
  - optional: `label`, `description`
- `[light:<label>]` — one per direct-network light adapter:
  - `backend = hue | wiz | lifx`
  - `topic = paradox/<room>/lights/<label>`
  - Hue: `host` (bridge IP), `api_key` (Hue Application Key), `hue_target_type` (`all`/`group`/`light`), `hue_target_id`, `hue_profile` (`color`/`ct`/`dim`)
  - WiZ: `host` (bulb IP) — UDP control, no cloud
  - LIFX: `api_key` (LIFX Cloud token)
- `[light-zone:<label>]` — fan-out group across multiple `[light:*]` adapters:
  - `topic = paradox/<room>/lights/<label>`
  - `devices = <light-label>, <light-label>, ...` (comma-separated)
- `[switch:<label>]` — one Shelly relay: `backend = shelly`, `host`, `port`
- `[dmx]` / `[dmx:<label>]` — DMX512 universe output
- `[effect:<label>]` — DMX effect device (fogger, strobe, hazer)

See [docs/CONFIG_INI.md](docs/CONFIG_INI.md) for full reference.

## MQTT Contract (Summary)

Per configured node:
- `{base_topic}/events` — normalized input events (retained, on-change)
- `{base_topic}/state` — latest signal snapshot (retained, on-change)
- `{base_topic}/commands` — output commands (relays) — not retained
- `{base_topic}/warnings` — per-node warnings (not retained)

Bridge-level:
- `{base_topic}/pzb/state` — retained heartbeat every `heartbeat_interval` seconds
- `{base_topic}/pzb/commands` — bridge-level commands (inclusion, diagnostics)
- `{base_topic}/pzb/warnings` — bridge-level warnings (radio disconnect, driver errors)
- `{base_topic}/pzb/discovered/<radio>/<id>` — retained discovery notices for unconfigured nodes

Event payload (matches PFx InputZone):

```json
{
  "input": "0",
  "event": "open",
  "source": "zwave-node-3",
  "ts": 1776900000000,
  "raw": { "...": "..." }
}
```

Full detail in [docs/MQTT_API.md](docs/MQTT_API.md).

## Pairing / Discovery Flow

1. Operator sends `{"command":"startInclusion"}` on `{base_topic}/pzb/commands` (or runs `pzb include --label spell-box`).
2. PxB enters inclusion mode and publishes progress on `{base_topic}/pzb/state` (phase: `including`).
3. Operator triggers the device to join (physical button / magnet tap).
4. PxB completes interview, assigns a default label (`discovered-<nodeId>` if none provided) and:
   - publishes a discovery notice on `{base_topic}/pzb/discovered/zwave/<nodeId>`
   - writes a generated INI fragment to stdout + a discovery sidecar file
   - keeps the node in-memory for the session so basic events are observable
5. Operator copies the INI fragment into the main config, adjusts `base_topic`/`type`, restarts PxB.

Generated fragment example:

```ini
# Discovered 2026-04-22T14:40:00Z — review and move into main config
[node:discovered-003]
radio = zwave
node_id = 3
type = contact           ; TODO: confirm — detected device class: Notification / Access Control
base_topic = paradox/houdini/zwave/discovered-003   ; TODO: set final topic
label = spell-box         ; TODO: set human label
```

## Event Normalization Rules

Contact sensors:
- `open` tokens → `open`
- `close`/`closed` tokens → `close`
- Z-Wave Notification CC AccessControl: 22 → `open`, 23 → `close`
- Boolean `true` → `open`, `false` → `close` (for contact profile only)

Relays (output echo):
- State updates when a relay command is confirmed: `signals.relay.value ∈ {on, off}` with `ts`.

## Heartbeat / Bridge Status

Published every `heartbeat_interval` seconds, retained. Shape:

```json
{
  "timestamp": "2026-04-22T14:40:00Z",
  "pid": 12345,
  "uptime_s": 1234,
  "state": "ok",
  "radios": {
    "zwave": { "enabled": true, "connected": true, "node_count": 4, "last_error": null },
    "zigbee": { "enabled": false }
  },
  "nodes": { "total": 4, "ready": 4, "failed": 0 },
  "subsystems": {
    "zwave-driver": "ok",
    "light-mirror": "ok",
    "light-zone1": "cooling-down"
  }
}
```

`state ∈ {ok, degraded, error, starting, stopping}`.
Subsystem status values: `ok | crashed | cooling-down | quarantined | fatal`. See §16 of [docs/SPEC.md](docs/SPEC.md) for crash budget semantics.

## Command Surface (initial)

Bridge-level (`{base_topic}/pzb/commands`):
- `startInclusion` / `stopInclusion`
- `startExclusion` / `stopExclusion`
- `refreshNode {label|node_id}`
- `removeFailedNode {node_id}`
- `getNetworkStatus`

Node-level (`{base_topic:node}/commands`) for outputs:
- `setRelay {state: on|off}`
- `pulseRelay {ms: <int>}`

## Lifecycle & Failure Semantics

- Missing serial port at startup → publish `pzb/state` with `state: error`, exit with non-zero so systemd restarts.
- Radio disconnect at runtime → `state: degraded`, attempt reconnect with backoff; publish warnings.
- Node reports failed → mark in registry; publish warning; keep trying until `removeFailedNode`.
- Graceful shutdown on SIGTERM: stop inclusion, close driver, publish `state: stopping`, disconnect MQTT last.

## Relationship to PFx

- PFx **stops** running direct Z-Wave (and later Zigbee) drivers.
- PFx input zones already subscribe to external MQTT topics — they consume PxB events unchanged once topics match.
- PFx light/relay backends gain a `bridge` mode: commands are published to a PxB node's `commands` topic; state is consumed from the node's `state` topic.

See `apps/PFx/docs/PR_ZWAVE_ZIGBEE_DIRECT.md` for the PFx-side migration.

## Testing Strategy

- Unit tests for INI loader, schema validation, normalizer, topic builders, INI fragment generator.
- Integration tests against a mocked zwave-js driver (event replay fixtures).
- Manual hardware smoke checklist for each radio.

## Commit Prefixes

`Docs:`, `Implement:`, `Fix:`, `Test:`, `Refactor:`, `Chore:`, `Scaffold:`.
