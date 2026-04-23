# PZB MQTT API

**Status:** Draft v0.1.

All PZB topics sit under a configurable `base_topic` from `[mqtt]` in the INI. Topic naming follows the Paradox convention `{baseTopic}/{commands|state|status|warnings}` both at the bridge level and at the per-node level. Payloads are JSON unless noted.

## 1. Topic Tree

```
{base_topic}/
  pzb/
    status                retained, periodic (bridge heartbeat)
    commands              not retained (bridge control)
    warnings              not retained (bridge-level warnings)
    discovered/
      zwave/<nodeId>      retained (discovery notice)
      zigbee/<ieeeTail>   retained (phase 3)
  <operator-defined per-node topic>/
    events                retained, on-change
    state                 retained, on-change
    commands              not retained (outputs only)
    warnings              not retained
```

The per-node segment is **fully operator-defined** via INI. Example: `paradox/houdini/zwave/spell-box` — PZB does not force a fixed tree.

## 2. Retention Rules

| Topic | Retained | Frequency |
|-------|:--------:|-----------|
| `pzb/state` | yes | Every `heartbeat_interval` (default 10s) |
| `pzb/commands` | no | On demand |
| `pzb/warnings` | no | On demand |
| `pzb/discovered/...` | yes | On discovery |
| `<node>/events` | yes | **Only on change** |
| `<node>/state` | yes | **Only on change** |
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
  "inclusion": { "active": false, "radio": null, "mode": null, "started_at": null, "timeout_ms": null }
}
```

`state ∈ {ok, degraded, error, starting, stopping}` (when inclusion/exclusion is active, `inclusion.active=true` and `inclusion.mode ∈ {inclusion, exclusion}`).

## 4. Bridge Commands (`pzb/commands`)

Not retained. Payloads:

| Command | Payload | Description |
|---------|---------|-------------|
| `startInclusion` | `{ "command":"startInclusion", "radio":"zwave", "label":"<optional>", "strategy":<int>, "timeout_s":<int> }` | Enter inclusion mode on given radio. `strategy` is a zwave-js `InclusionStrategy` (`0`=Default/prefers S2, `2`=Insecure, `3`=S0, `4`=S2). **Defaults to `2` (Insecure)** because S2 bootstrap requires user callbacks that PZB does not yet provide; omit `strategy` for the safe default. |
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

Retained. Only published when any signal changes (or on driver disconnect). Reflects the most recent event.

```json
{ "event": "open", "ts": "2026-04-22T23:10:36.936Z", "source": "zwave-node-3" }
```

Before any event has been received: `{ "event": null, "ts": null, "source": null }`.

## 9. Per-Node Commands (`{node.base_topic}/commands`)

Not retained. Only meaningful for output-capable types (relay, switch, dimmer).

```json
{ "command": "setRelay", "state": "on" }
{ "command": "pulseRelay", "ms": 500 }
```

Unknown commands produce a per-node warning and are ignored.

## 10. Per-Node Warnings (`{node.base_topic}/warnings`)

Not retained. Same shape as bridge warnings.

Standard codes:
- `NODE_FAILED`, `NODE_RECOVERED`
- `LOW_BATTERY`
- `COMMAND_TIMEOUT`
- `COMMAND_UNSUPPORTED`

## 11. Compatibility with PFx

The `events` payload intentionally uses the minimal `{"event":"open"|"close"}` shape. PFx `InputZone` in MQTT consumer mode only requires the `event` field, so an existing PFx `input_topic` pointing at `{node.base_topic}/events` works with zero PFx changes.

## 12. Versioning

`pzb/state.version` reflects PZB's semantic version. API-breaking changes require a bump and a migration note in this document.
