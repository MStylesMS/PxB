# PZB Functional Specification

**Status:** Draft v0.1 — design locked, implementation not started.

## 1. Scope

PZB (Paradox Z Bridge) is a single-process Node.js service that bridges Z-Wave (and later Zigbee / Thread) USB radios to MQTT using the Paradox topic contract. It is deployed on a Linux host (Raspberry Pi or equivalent) and is the sole owner of the radio serial endpoint(s) on that host.

## 2. Supported Hardware (Phase 1)

- Z-Wave via `zwave-js` using any zwave-js-supported USB controller.
- Reference hardware: HUSBZB-1 (Z-Wave endpoint).
- Zigbee and Thread support are planned; Zigbee targets `zigbee-herdsman` with the Ember adapter on HUSBZB-1.

## 3. Supported Device Classes

Phase 1 hardware support:
- **Contact sensors** (input) — open/close events.
- **Relays / switches** (output) — on/off, pulse.

Additional classes (dimmers, multilevel sensors, thermostats, etc.) are explicitly **out of scope for phase 1** and will be added in later phases as separate PRs.

## 4. Core Responsibilities

1. Load an INI configuration file describing the bridge and its known nodes.
2. Open and own the radio serial port(s) as a singleton driver per radio.
3. Discover / interview nodes as configured or as newly included.
4. Normalize radio events into PZB's common event/state schema.
5. Publish node events and state over MQTT per the topic contract.
6. Publish a retained bridge-level heartbeat at a configured interval.
7. Accept bridge-level and node-level commands over MQTT and via a CLI.
8. On inclusion of a new device, produce an INI fragment suitable for the downstream consumer (PFx) with clear placeholders.

## 5. Non-Goals

- Web UI.
- Automation / rules engine (PxO and PFx `input_map` cover this).
- Multi-tenant radio sharing across processes.
- Broad device-class coverage in phase 1.
- Silent auto-publishing under guessed topics for unknown nodes.

## 6. Process Model

- One PZB process per host.
- Runs under systemd in production; runs via `node src/index.js` in dev.
- Singleton per radio serial port inside the process.
- Clean shutdown on SIGTERM: stop any active inclusion, close driver(s), publish bridge `state: stopping`, disconnect MQTT last.

## 7. Configuration Model

INI file. One file per process. Sections:

- `[mqtt]` — broker connection + `base_topic`.
- `[global]` — log level, heartbeat interval, discovered topic prefix.
- `[zwave]` — serial port, network key(s), enable flag.
- `[zigbee]` — serial port, adapter type, db path, enable flag.
- `[node:<label>]` — one per known device.

See [CONFIG_INI.md](CONFIG_INI.md) for full key list.

## 8. Node Identification

- Z-Wave nodes are identified by integer `node_id` (1–232).
- Zigbee devices are identified by `ieee` address.
- Each node has an operator-chosen `label` used in MQTT topics and logs.
- Discovered-but-unconfigured nodes get a default label `discovered-<nodeId>` (Z-Wave) or `discovered-<ieeeTail>` (Zigbee).

## 9. Topic Contract Summary

See [MQTT_API.md](MQTT_API.md) for canonical definitions. Summary:

- Per node: `{base_topic}/events`, `/state`, `/schema`, `/commands`, `/warnings`.
- Bridge: `{base_topic}/pzb/state`, `/commands`, `/warnings`, `/discovered/<radio>/<id>`.

Retention rules:
- Bridge `pzb/state`: **retained**, periodic (default 10s).
- Node `events`: **retained**, published only when an event occurs.
- Node `state`: **retained**, published only when telemetry changes (state, battery, reachable, tamper).
- Node `schema`: **retained**, published once at PZB startup (and on driver reconnect).
- Node `commands` and `warnings`, bridge `commands` and `warnings`: **not retained**.
- Discovery notices: **retained**.

## 10. Event Schema (Normalized)

Short, retained per-node event payload:

```json
{ "event": "open" }
```

Normalized tokens by type:

| Type | Events |
|------|--------|
| contact | `open`, `close` |
| motion (future) | `presence`, `clear` |
| relay (echo) | `on`, `off` |

## 11. State Schema

Flat retained snapshot per node. Published only when a signal changes.

```json
{
  "state":    "opened" | "closed" | null,
  "ts":       "<iso8601>" | null,
  "battery":   { "level": 0-100, "ts": "<iso8601>" } | null,
  "reachable": { "value": true,  "ts": "<iso8601>" } | null,
  "tamper":    { "active": false, "ts": "<iso8601>" } | null,
  "source":    "zwave-node-<n>" | null
}
```

- `state` / `ts` are present only for contact-type nodes.
- Omitted or `null` signals have not yet been reported.
- See [MQTT_API.md §8](MQTT_API.md) for the authoritative shape and schema topic.

## 12. Bridge Status Schema

See [AI-DETAILED-OVERVIEW.md](../AI-DETAILED-OVERVIEW.md#heartbeat--bridge-status) for the canonical shape.

## 13. Command Surface (Phase 1)

**Bridge commands** (`{base_topic}/pzb/commands`):
- `startInclusion`
- `stopInclusion`
- `startExclusion`
- `stopExclusion`
- `refreshNode { label | node_id }`
- `removeFailedNode { node_id }`
- `getNetworkStatus`

**Node commands** (`{node.base_topic}/commands`, for relay/switch types):
- `setRelay { state: "on"|"off" }`
- `pulseRelay { ms: <int> }`

All commands must be accepted both via MQTT JSON and via the equivalent CLI (`pzb include`, `pzb relay`, `pzb status`, `pzb dump-ini`, etc.).

## 14. Discovery / Pairing

1. Operator starts inclusion via MQTT or `pzb include [--label <name>]`.
2. Bridge enters `including` state, reflected in `pzb/state`.
3. When a node joins, PZB interviews it.
4. On successful interview:
   - Retained discovery notice published on `{base_topic}/pzb/discovered/<radio>/<id>`.
   - INI fragment emitted to stdout and appended to `discovered.ini` sidecar next to the main config.
   - Node is held in runtime registry so events are observable under a `discovered-<n>` label.
5. Operator edits INI (sets `base_topic`, `type`, `label`) and restarts PZB.

INI fragment is generated with clearly marked `TODO:` comments for every field requiring human input.

## 15. Warning Semantics

- Radio disconnect → bridge warning + `state: degraded`.
- Failed node transitions → per-node warning.
- Unknown command on a node type → per-node warning, no error.
- Command referencing unknown node → bridge warning.

Warnings are JSON: `{ "timestamp", "severity": "info|warn|error", "code", "message", "context": { ... } }`.

## 16. Failure Modes

| Condition | Behavior |
|-----------|----------|
| Serial port missing at startup | Publish bridge error status, exit non-zero (systemd restarts). |
| Serial port lost at runtime | `state: degraded`; exponential backoff reconnect; publish warnings. |
| MQTT disconnect | Continue radio operation; queue outbound state/events up to a bounded buffer; republish on reconnect (retained messages rewrite naturally). |
| Malformed INI | Refuse to start; log actionable error. |
| Unknown command | Publish warning; do not crash. |

## 17. Security Posture

- Network keys (S0/S2) live in INI only; file should be `0600`.
- No secrets ever published over MQTT.
- MQTT credentials optional; TLS optional (phase 5 hardening).

## 18. Out-of-Scope in Phase 1

- Thread support (future phase).
- Multilevel sensors, thermostats, locks.
- Web UI.
- TLS, ACL enforcement on MQTT.

(Zigbee was moved out of scope for phase 1 and is now implemented as of phase 3.)

## 19. Supported Devices

This section tracks real-world device validation for PZB. Device profile documents live in `docs/supported/` and include pairing and operations notes.

### 19.1 Z-Wave Devices

| Vendor | Model | Device Type | Validation Status | Profile |
|--------|-------|-------------|-------------------|---------|
| Zooz | ZSE41 800LR Open/Close XS Sensor | Contact sensor | Active validation in this environment; known-good model family for ZSE41 support path | [Zooz ZSE41 800LR](supported/zooz-zse41-800lr.md) |

### 19.2 Zigbee Devices

| Vendor | Model | Device Type | Validation Status | Profile |
|--------|-------|-------------|-------------------|---------|
| Third Reality | 3RDS17BZ Door Sensor | Contact sensor | PZB support implemented; hardware validation pending | [Third Reality 3RDS17BZ](supported/third-reality-3rds17bz.md) |

## 20. References

- [CONFIG_INI.md](CONFIG_INI.md)
- [MQTT_API.md](MQTT_API.md)
- [QUICK_START.md](QUICK_START.md)
- [PR_PZB_INITIAL.md](PR_PZB_INITIAL.md)
- PFx migration: `apps/PFx/docs/PR_ZWAVE_ZIGBEE_DIRECT.md`
