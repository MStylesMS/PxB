# PxB MQTT API

**Status:** Draft v0.1.

All PxB topics sit under a configurable `base_topic` from `[mqtt]` in the INI. Topic naming follows the Paradox convention `{baseTopic}/{commands|events|state|warnings}` both at the bridge level and at the per-node level. Payloads are JSON unless noted.

## 1. Topic Tree

```
{base_topic}/
  pzb/
    state                 retained, periodic (bridge heartbeat/lifecycle)
    commands              not retained (bridge control)
    warnings              not retained (bridge-level warnings)
    discovered/
      zwave/<nodeId>      retained (discovery notice)
      zigbee/<ieeeTail>   retained (phase 3)
  <operator-defined per-node topic>/
    schema                retained, once at startup
    events                retained, on-change
    state                 retained, on-telemetry-change
    commands              not retained (outputs only)
    warnings              not retained
```

The per-node segment is **fully operator-defined** via INI. Example: `paradox/houdini/zwave/spell-box` — PxB does not force a fixed tree.

## 2. Retention Rules

| Topic | Retained | Frequency |
|-------|:--------:|-----------|
| `pzb/state` | yes | Every `heartbeat_interval` (default 10s) |
| `pzb/commands` | no | On demand |
| `pzb/warnings` | no | On demand |
| `pzb/discovered/...` | yes | On discovery |
| `<node>/schema` | yes | **Once at startup** per node (and on driver reconnect) |
| `<node>/events` | yes | **Only on event** |
| `<node>/state` | yes | **Only when telemetry changes** (state, battery, reachable, tamper) |
| `<node>/commands` | no | On demand |
| `<node>/warnings` | no | On demand |

## 3. Bridge State (`pzb/state`)

Retained. Republished every `heartbeat_interval` seconds.

```json
{
  "timestamp": "2026-04-22T14:40:00.123Z",
  "pid": 12345,
  "uptime_s": 1234,
  "state": "ok",
  "version": "0.1.0",
  "host": "pi5-ssd",
  "radios": {
    "zwave":  { "enabled": true,  "connected": true,  "port": "/dev/zwave", "node_count": 4, "last_error": null },
    "zigbee": { "enabled": false }
  },
  "nodes": { "total": 4, "ready": 4, "failed": 0, "interviewing": 0 },
  "inclusion": { "active": false, "radio": null, "mode": null, "started_at": null, "timeout_ms": null },
  "subsystems": {
    "mqtt-client":  "ok",
    "zwave-driver": "ok",
    "zigbee-driver": "ok",
    "light-mirror": "ok",
    "switch-fogger": "crashed"
  }
}
```

`state ∈ {ok, degraded, error, starting, stopping}` (when inclusion/exclusion is active, `inclusion.active=true` and `inclusion.mode ∈ {inclusion, exclusion}`).

`subsystems` maps each registered subsystem id to its status. Status values:

| Status | Meaning |
|--------|---------|
| `ok` | Subsystem is running normally |
| `crashed` | Subsystem threw an unhandled error; it has been contained and stopped. The rest of PxB is still running. |
| `fatal` | Reserved for future use (fatal subsystem crash drives process exit before status can be written) |

Subsystem ids follow the convention `<kind>-<label>`, e.g. `light-mirror`, `switch-fogger`, `zwave-driver`.

## 4. Bridge Commands (`pzb/commands`)

Not retained. Payloads:

| Command | Payload | Description |
|---------|---------|-------------|
| `startInclusion` | `{ "command":"startInclusion", "radio":"zwave", "label":"<optional>", "strategy":<int>, "timeout_s":<int> }` | Enter inclusion mode on given radio. `strategy` is a zwave-js `InclusionStrategy` (`0`=Default/prefers S2, `2`=Insecure, `3`=S0, `4`=S2). **Defaults to `2` (Insecure)** because S2 bootstrap requires user callbacks that PxB does not yet provide; omit `strategy` for the safe default. |
| `stopInclusion` | `{ "command":"stopInclusion", "radio":"zwave" }` | Exit inclusion mode. |
| `startExclusion` | `{ "command":"startExclusion", "radio":"zwave" }` | Enter exclusion mode. |
| `stopExclusion` | `{ "command":"stopExclusion", "radio":"zwave" }` | Exit exclusion mode. |
| `refreshNode` | `{ "command":"refreshNode", "node_id":3 }` | Re-interview a node. |
| `removeFailedNode` | `{ "command":"removeFailedNode", "node_id":3 }` | Remove a failed Z-Wave node from the controller. |
| `getNetworkStatus` | `{ "command":"getNetworkStatus" }` | Force-publish `pzb/state` immediately. |

## 5. Bridge Warnings (`pzb/warnings`)

Not retained. Emitted on operational issues.

```json
{
  "timestamp": "...",
  "severity": "warn",
  "code": "ZWAVE_DISCONNECTED",
  "message": "Z-Wave serial port closed unexpectedly",
  "context": { "port": "/dev/zwave" }
}
```

Standard codes (phase 1):
- `ZWAVE_DISCONNECTED`, `ZWAVE_RECONNECTED`
- `INCLUSION_TIMEOUT`, `EXCLUSION_TIMEOUT`
- `UNKNOWN_NODE_COMMAND`
- `CONFIG_VALIDATION_WARNING`

Standard codes (fault isolation):
- `SUBSYSTEM_CRASH` — An optional subsystem threw an uncaught exception or unhandled rejection. The process kept running; the subsystem has been stopped. Payload `context` includes `subsystem_id` (e.g. `light-mirror`) and `kind` (e.g. `output-adapter`). Severity: `error`.

## 6. Discovery Notices (`pzb/discovered/<radio>/<id>`)

Retained. Emitted when inclusion produces a new node.

```json
{
  "timestamp": "...",
  "radio": "zwave",
  "node_id": 3,
  "descriptor": {
    "node_id": 3,
    "manufacturer_id": 134,
    "product_type": 258,
    "product_id": 100,
    "device_class_generic": "Binary Sensor",
    "device_class_specific": "Door/Window Sensor",
    "label": "Door/Window Sensor 7",
    "guessed_type": "contact"
  },
  "fragment": "; ---- Discovered ... ----\n[node:discovered-3]\nradio       = zwave\nnode_id     = 3\ntype        = contact\nbase_topic  = TODO: ...\ndescription = TODO: ...\n"
}
```

A companion INI fragment is also written to `[global] discovered_ini_path` (when configured) and can be retrieved with `pzb dump-ini --node-id N`.

## 7. Per-Node Events (`{node.base_topic}/events`)

Retained. Only published when an event actually changes observable state (de-duplication on identical consecutive events is optional but recommended).

```json
{ "event": "open" }
```

Event token vocabulary: `open` | `close`.

## 8. Per-Node State (`{node.base_topic}/state`)

Retained. Published only when telemetry changes (contact state, battery level, reachability, or tamper). Shape is flat with per-signal timestamps so consumers can tell which signal most recently updated.

```json
{
  "state": "opened",
  "ts": "2026-04-22T23:10:36.936Z",
  "battery":   { "level": 62, "ts": "2026-04-22T23:05:00.000Z" },
  "reachable": { "value": true, "ts": "2026-04-22T23:10:36.936Z" },
  "tamper":    null,
  "source":    "zwave-node-3"
}
```

Field semantics:
- `state` / `ts` — present only for contact-type nodes. `state ∈ { "opened", "closed", null }`; `ts` is the timestamp of the last event that produced `state`.
- `battery` — Battery CC (128) level, 0-100. `null` until first report.
- `reachable` — Derived from zwave-js node status (`alive` → `true`; `dead`/`failed`/`offline` → `false`).
- `tamper` — `{ active: bool, ts: iso8601 }` or `null` until supported by the device.
- `source` — `"zwave-node-<N>"` identifying the origin radio node.

Before any telemetry has been received for a node, PxB does not publish `state` at all (consumers should treat missing retained state as "unknown"). On driver disconnect PxB publishes `reachable: { value: false, ... }`.

## 8a. Per-Node Schema (`{node.base_topic}/schema`)

Retained. Published once per configured node on PxB startup (and again on Z-Wave driver reconnect). Describes the node's topic layout and payload shapes so consumers can bind without hard-coding.

```json
{
  "application": "pzb",
  "label": "spell-box",
  "radio": "zwave",
  "type": "contact",
  "node_id": 8,
  "topics": {
    "events":   "paradox/houdini/zwave/spell-box/events",
    "state":    "paradox/houdini/zwave/spell-box/state",
    "commands": "paradox/houdini/zwave/spell-box/commands",
    "warnings": "paradox/houdini/zwave/spell-box/warnings"
  },
  "event_values": ["open", "close"],
  "state_fields": {
    "state":     "'opened' | 'closed' | null",
    "ts":        "iso8601 | null",
    "battery":   "{ level: 0-100, ts: iso8601 } | null",
    "reachable": "{ value: boolean, ts: iso8601 } | null",
    "tamper":    "{ active: boolean, ts: iso8601 } | null",
    "source":    "'zwave-node-N' | null"
  },
  "retention": { "events": true, "state": true, "schema": true }
}
```

## 9. Per-Node Commands (`{node.base_topic}/commands`)

Not retained. Only meaningful for output-capable types (relay, switch, dimmer).

```json
{ "command": "setRelay", "state": "on" }
{ "command": "pulseRelay", "ms": 500 }
```

Unknown commands produce a per-node warning and are ignored.

## 9a. Light Commands (`{light.topic}/commands`)

For configured light backends (`hue`, `wiz`, `lifx`), PxB accepts light-zone commands on the same Paradox command topic shape:

```json
{ "command": "scene", "scene": "cyan" }
{ "command": "setColorScene", "scene": "cyan" }
{ "command": "setColorScene", "scene": "warmWhite" }
{ "command": "on", "brightness": 80 }
{ "command": "off" }
{ "command": "setBrightness", "brightness": 65 }
{ "command": "setColor", "color": "#00DCFF", "brightness": 75 }
{ "command": "setColorTemp", "kelvin": 3000, "brightness": 70 }
{ "command": "fade", "brightness": 15, "duration": 2 }
{ "command": "allOff" }
{ "command": "allOn" }
{ "command": "getState" }
{ "command": "getStatus" }
```

`setColorScene` is the PFx-compatible scene command used by existing room/operator UIs.

Built-in scene names are aligned across Hue/WiZ/LIFX and can be tuned per backend with `scene_map` in INI:
- `normal`, `dim`, `red`, `blue`, `green`, `yellow`, `orange`, `purple`, `pink`, `cyan`, `magenta`, `white`, `softWhite`, `brightWhite`, `warmWhite`, `coolWhite`, `off`

`[light-zone:*]` topics use the same command payloads. Zones are backend-agnostic:
PxB fans a command out to each member light adapter, and each adapter should apply
the supported parts of the request while publishing warnings when the request asks
for a capability that backend cannot satisfy.

## 10. Per-Node Warnings (`{node.base_topic}/warnings`)

Not retained. Same shape as bridge warnings.

Standard codes:
- `NODE_FAILED`, `NODE_RECOVERED`
- `LOW_BATTERY`
- `COMMAND_TIMEOUT`
- `COMMAND_UNSUPPORTED`

## 11. Relationship with PFx

PFx no longer consumes radio events; Z-Wave / Zigbee I/O is owned entirely by PxB. Consumers such as PxO, PxT, and dashboards subscribe directly to the per-node topics described above. Future PFx integration is limited to outbound adapter work (translating generic light/relay commands into PxB `{node.base_topic}/commands` payloads). Do not add `[input:*]` sections in PFx INI for zwave/zigbee sensors.

## 12. Versioning

`pzb/state.version` reflects PxB's semantic version. API-breaking changes require a bump and a migration note in this document.
