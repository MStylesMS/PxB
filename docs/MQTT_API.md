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
| `pzb/status` | yes | Every `heartbeat_interval` (default 10s) |
| `pzb/commands` | no | On demand |
| `pzb/warnings` | no | On demand |
| `pzb/discovered/...` | yes | On discovery |
| `<node>/events` | yes | **Only on change** |
| `<node>/state` | yes | **Only on change** |
| `<node>/commands` | no | On demand |
| `<node>/warnings` | no | On demand |

## 3. Bridge Status (`pzb/status`)

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
  "inclusion": { "active": false, "radio": null, "started_at": null }
}
```

`state ∈ {ok, degraded, error, starting, stopping, including}`.

## 4. Bridge Commands (`pzb/commands`)

Not retained. Payloads:

| Command | Payload | Description |
|---------|---------|-------------|
| `startInclusion` | `{ "command":"startInclusion", "radio":"zwave", "label":"<optional>" }` | Enter inclusion mode on given radio. |
| `stopInclusion` | `{ "command":"stopInclusion", "radio":"zwave" }` | Exit inclusion mode. |
| `startExclusion` | `{ "command":"startExclusion", "radio":"zwave" }` | Enter exclusion mode. |
| `stopExclusion` | `{ "command":"stopExclusion", "radio":"zwave" }` | Exit exclusion mode. |
| `refreshNode` | `{ "command":"refreshNode", "node_id":3 }` | Re-interview a node. |
| `removeFailedNode` | `{ "command":"removeFailedNode", "node_id":3 }` | Remove a failed Z-Wave node from the controller. |
| `getNetworkStatus` | `{ "command":"getNetworkStatus" }` | Force-publish `pzb/status` immediately. |

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
  "label_assigned": "discovered-003",
  "device_class": "Notification Sensor / Access Control",
  "manufacturer": "Aeotec",
  "product": "Door/Window Sensor 7",
  "ini_fragment_path": "/opt/paradox/config/pzb/discovered.ini"
}
```

A companion INI fragment is written to disk (see `ini_fragment_path`).

## 7. Per-Node Events (`{node.base_topic}/events`)

Retained. Only published when an event actually changes observable state (de-duplication on identical consecutive events is optional but recommended).

```json
{
  "input": "0",
  "event": "open",
  "source": "zwave-node-3",
  "ts": 1776900000000,
  "raw": { "commandClass": 113, "property": "Access Control", "newValue": 22 }
}
```

Event token vocabulary is defined in [SPEC.md § 10](SPEC.md#10-event-schema-normalized).

## 8. Per-Node State (`{node.base_topic}/state`)

Retained. Only published when any signal changes. See [SPEC.md § 11](SPEC.md#11-state-schema) for shape.

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

The event payload shape is intentionally identical to what `PFx InputZone` already accepts, so an existing PFx `input_topic` pointing at `{node.base_topic}/events` works with zero PFx changes.

## 12. Versioning

`pzb/status.version` reflects PZB's semantic version. API-breaking changes require a bump and a migration note in this document.
