# PxB MQTT API

**Status:** Draft v0.1.

All PxB topics sit under a configurable `base_topic` from `[mqtt]` in the INI. Topic naming follows the Paradox convention `{baseTopic}/{commands|events|state|warnings}` both at the bridge level and at the per-node level. Payloads are JSON unless noted.

## 1. Topic Tree

```
{base_topic}/
  pxb/
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
| `pxb/state` | yes | Every `heartbeat_interval` (default 10s) |
| `pxb/commands` | no | On demand |
| `pxb/warnings` | no | On demand |
| `pxb/discovered/...` | yes | On discovery |
| `<node>/schema` | yes | **Once at startup** per node (and on driver reconnect) |
| `<node>/events` | yes | **Only on event** |
| `<node>/state` | yes | **Only when telemetry changes** (state, battery, reachable, tamper) |
| `<node>/commands` | no | On demand |
| `<node>/warnings` | no | On demand |

## 3. Bridge State (`pxb/state`)

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
| `cooling-down` | Subsystem is crash-looping (4–10 crashes in 60 s); further `onCrash` invocations are suppressed for 60 s. |
| `quarantined` | Subsystem exceeded the crash budget across multiple cooldown cycles; it is permanently disabled until the next PxB restart. |
| `fatal` | Reserved for future use (fatal subsystem crash drives process exit before status can be written) |

Subsystem ids follow the convention `<kind>-<label>`, e.g. `light-mirror`, `switch-fogger`, `zwave-driver`.

## 4. Bridge Commands (`pxb/commands`)

Not retained. Payloads:

| Command | Payload | Description |
|---------|---------|-------------|
| `startInclusion` | `{ "command":"startInclusion", "radio":"zwave", "label":"<optional>", "strategy":<int>, "timeout_s":<int> }` | Enter inclusion mode on given radio. `strategy` is a zwave-js `InclusionStrategy` (`0`=Default/prefers S2, `2`=Insecure, `3`=S0, `4`=S2). **Defaults to `2` (Insecure)** because S2 bootstrap requires user callbacks that PxB does not yet provide; omit `strategy` for the safe default. |
| `stopInclusion` | `{ "command":"stopInclusion", "radio":"zwave" }` | Exit inclusion mode. |
| `startExclusion` | `{ "command":"startExclusion", "radio":"zwave" }` | Enter exclusion mode. |
| `stopExclusion` | `{ "command":"stopExclusion", "radio":"zwave" }` | Exit exclusion mode. |
| `refreshNode` | `{ "command":"refreshNode", "node_id":3 }` | Re-interview a node. |
| `removeFailedNode` | `{ "command":"removeFailedNode", "node_id":3 }` | Remove a failed Z-Wave node from the controller. |
| `getNetworkStatus` | `{ "command":"getNetworkStatus" }` | Force-publish `pxb/state` immediately. |

## 5. Bridge Warnings (`pxb/warnings`)

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
- `SUBSYSTEM_QUARANTINED` — A subsystem exceeded its crash budget and has been permanently disabled for the lifetime of this process. Payload `context` includes `subsystem_id`, `kind`, `crash_count`, and `window_s`. Severity: `error`.

## 6. Discovery Notices (`pxb/discovered/<radio>/<id>`)

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

A companion INI fragment is also written to `[global] discovered_ini_path` (when configured) and can be retrieved with `pxb dump-ini --node-id N`.

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
  "application": "pxb",
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

For configured light backends (`hue`, `wiz`, `lifx`, `dmx`), PxB accepts light-zone commands on the same Paradox command topic shape:

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

### DMX backend command surface (`backend = dmx`, Phase 7)

The `dmx` backend supports the full command surface below. Unsupported commands
are **acknowledged with a structured warning** on `{topic}/warnings` and never silently dropped.

| Command | Phase | Notes |
|---|---|---|
| `on`, `allOn`, `off`, `allOff` | 2 | Optional `fadeTime` (seconds, float) for timed fade |
| `setBrightness` | 2 | Optional `fadeTime` |
| `setColor` | 2 | Optional `fadeTime`; requires `color` capability |
| `setColorScene` / `scene` | 2 | Sets a named color scene |
| `getState` / `getStatus` | 2 | Re-publishes retained state |
| `setColorTemp` | — | ⚠ unsupported — use `setColor` or a named scene |
| `fade` | 7 | Fade to brightness/color over `fadeTime` seconds |
| `moveTo`, `home` | 6 | Moving-head motion (see §9c) |
| `setStrobe` | 7 | Software strobe at given Hz and duty cycle |
| `stopStrobe` | 7 | Stop software strobe; optionally restore color/brightness |
| `setDmxStrobe` | 7 | Hardware strobe channel passthrough (requires `strobe` capability) |
| `dmxStrobeOff` | 7 | Zero hardware strobe channel |

Warning code for unsupported commands: `DMX_CMD_UNSUPPORTED`.

### §9d. Fade commands

`on`, `off`, `setBrightness`, `setColor`, and `fade` all accept an optional `fadeTime` parameter.

| Field | Type | Required | Description |
|---|---|---|---|
| `fadeTime` | float | No | Fade duration in **seconds** (e.g. `2.5`). `0` or omitted = immediate |

**Examples**

```json
{ "command": "setBrightness", "brightness": 80, "fadeTime": 3 }
{ "command": "off", "fadeTime": 2.5 }
{ "command": "fade", "brightness": 50, "color": { "r": 255, "g": 100, "b": 0 }, "fadeTime": 1.5 }
```

Fade runs at 30 Hz using chained `setTimeout` ticks. Any new output command issued while a fade is in progress cancels the fade immediately.

### §9e. Software strobe commands

#### setStrobe

```json
{ "command": "setStrobe", "strobeHz": 5, "strobeDuty": 50, "color": { "r": 255, "g": 255, "b": 255 }, "brightness": 100 }
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `strobeHz` | float | Yes | — | Strobe frequency in Hz (clamped to 0.1–25 Hz) |
| `strobeDuty` | int | No | `50` | On-phase duty cycle as a percentage (1–99) |
| `color` | object `{r,g,b}` | No | Current color or white | Color during on-phase |
| `brightness` | int 0–100 | No | Current brightness or 100 | Brightness during on-phase |

The off-phase zeros all fixture channels. The logical state is preserved so `stopStrobe` can restore it.

**Warning**: `DMX_STROBE_HZ_CLAMPED` — issued when `strobeHz` exceeds 25 Hz; value is clamped.

#### stopStrobe

```json
{ "command": "stopStrobe" }
{ "command": "stopStrobe", "brightness": 60 }
{ "command": "stopStrobe", "color": { "r": 200, "g": 100, "b": 0 }, "brightness": 80 }
```

Cancels the strobe. With no extra params the fixture is left dark. Optional `color` and `brightness` restore the fixture atomically.

**Events**

| Event | When |
|---|---|
| `strobe-started` | `setStrobe` accepted | `strobeHz`, `strobeDuty`, `color`, `brightness` |
| `strobe-stopped` | `stopStrobe` processed | — |

**State** while strobing includes `strobing: true, strobeHz, strobeDuty`.

### §9f. Hardware strobe passthrough

Requires the `strobe` capability in the fixture profile (e.g. `par-7ch`).

#### setDmxStrobe

Writes a raw 0–255 value to the fixture's hardware strobe channel.

```json
{ "command": "setDmxStrobe", "value": 180 }
```

| Field | Type | Required | Description |
|---|---|---|---|
| `value` | int 0–255 | Yes | DMX value for the strobe channel |

#### dmxStrobeOff

Zeroes the hardware strobe channel. No-op on fixtures without a `strobe` slot.

```json
{ "command": "dmxStrobeOff" }
```

### §9g. Bridge-level DMX universe commands

Sent to `{pxb_base_topic}/pxb/commands` (the bridge-wide command topic).

| Command | Params | Description |
|---|---|---|
| `dmxBlackoutAll` | — | Apply master blackout to **all** configured universes |
| `dmxRestoreAll` | — | Lift master blackout on all universes |
| `dmxBlackout` | `universe` (string, default `"default"`) | Blackout a single universe |
| `dmxRestore` | `universe` (string) | Restore a single universe |
| `dmxStartRecording` | `universe` (string, default `"default"`) | Begin frame-level recording |
| `dmxStopRecording` | `universe` (string) | Stop recording; frames available in memory |
| `dmxPlayRecording` | `universe` (string), `loop` (bool, default `false`) | Play recorded frames |
| `dmxStopPlayback` | `universe` (string) | Stop playback |

**Master blackout** gates the wire frame to all-zero without clearing the adapter's internal state. Adapters continue writing to the buffer during blackout; `dmxRestoreAll` immediately applies the latest state.

**Recording** captures frame snapshots at each transmission tick (up to 30 Hz). Only frames that differ from the previous snapshot are stored. `playRecording` replays them with the original inter-frame timing.

## 9b. Effect Commands (`{effect.topic}/commands`)

Effect adapters control short-duration effect devices (foggers, strobes, hazers). Commands use the same `{ "command": "...", ...params }` envelope as all PxB adapters.

| Command | Required params | Optional params | Description |
|---|---|---|---|
| `burst` | `duration_ms` (integer ≥ 1) | `intensity` (0–100, default = config `intensity`) | Fire output for `duration_ms` ms then auto-stop. Rejected if `duration_ms` > config `max_run_ms`. |
| `pulse` | `duration_ms` (integer ≥ 1) | `intensity` (0–100) | Alias for `burst`. |
| `stop` | — | — | Immediately zero all channels and cancel any running timer. |
| `setIntensity` | `intensity` (0–100) | — | Set output level without a timer (stays on until `stop` or overwritten). |
| `getStatus` | — | — | Re-publish current state to `{effect.topic}/state`. |

### State (`{effect.topic}/state`) — retained

```json
{
  "on":         false,
  "intensity":  0,
  "expires_at": null,
  "fixture":    "fogger-1ch",
  "address":    1,
  "timestamp":  "2026-05-12T10:00:00.000Z"
}
```

`expires_at` is an ISO-8601 timestamp when the current burst will auto-stop, or `null` if no timer is running.

### Events (`{effect.topic}/events`)

| Event | When | Extra fields |
|---|---|---|
| `burst-started` | Burst begins | `intensity`, `duration_ms`, `expires_at` |
| `burst-ended`   | Auto-stop after timer expires | `intensity` |
| `stopped`       | Manual `stop` command (was running) | — |
| `intensity-updated` | `setIntensity` processed | `intensity` |

### Warning codes

| Code | Meaning |
|---|---|
| `EFFECT_CMD_INVALID` | Malformed payload or missing required parameter |
| `EFFECT_CMD_UNKNOWN` | Unrecognised command name |
| `EFFECT_DURATION_CAPPED` | `duration_ms` exceeds `max_run_ms`; command rejected |

### Safety

Every effect adapter enforces a `max_run_ms` ceiling (INI key, default 4000). Any burst/pulse with `duration_ms > max_run_ms` is rejected with an `EFFECT_DURATION_CAPPED` warning — the device never fires. On adapter `dispose()` (including process shutdown), all channels are zeroed and the timer is cancelled.

## 9c. Mover Commands (`{light.topic}/commands`)

Moving-head fixtures (profiles `mover-8ch`, `mover-12ch`, `mover-basic`) expose pan/tilt motion commands in addition to all standard light commands.

### moveTo

Move the fixture to an absolute position.

```json
{ "command": "moveTo", "position": "stage-left" }
```

Or using raw values (0–255):

```json
{ "command": "moveTo", "pan": 100, "tilt": 80, "speed": 0 }
```

| Field | Type | Required | Description |
|---|---|---|---|
| `position` | string | Either `position` or `pan`/`tilt` | Named position defined in the `positions` INI key |
| `pan` | integer 0–255 | See above | Raw coarse pan value |
| `tilt` | integer 0–255 | See above | Raw coarse tilt value |
| `speed` | integer 0–255 | No (default 0) | Movement speed (0 = max speed on most fixtures) |

If `position` is given and `pan`/`tilt` are also present they are ignored; the named position wins.

### home

Return the fixture to the home position (default: pan 128, tilt 128; overridable via the `positions` config key).

```json
{ "command": "home" }
```

### State shape for mover fixtures

When the fixture profile includes the `pan` capability, the state payload includes two additional fields:

```json
{
  "timestamp": "2024-01-01T00:00:00.000Z",
  "on": true,
  "brightness": 100,
  "color": null,
  "scene": null,
  "fixture": "mover-8ch",
  "address": 1,
  "pan": 128,
  "tilt": 128
}
```

`pan` and `tilt` are `null` until the first `moveTo` or `home` command is processed.

### Events

| Event | When | Extra fields |
|---|---|---|
| `moved` | Position command applied | `pan`, `tilt` |

### Warning codes

| Code | Meaning |
|---|---|
| `DMX_POSITION_UNKNOWN` | Named position not found in the fixture's `positions` map |
| `DMX_CMD_INVALID` | `moveTo` received with neither `position` name nor `pan`/`tilt` values |
| `DMX_CMD_UNSUPPORTED` | Motion command sent to a fixture without `pan` capability |

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

`pxb/state.version` reflects PxB's semantic version. API-breaking changes require a bump and a migration note in this document.

---

## 13. MQTT-Native Light Devices

Some Paradox light fixtures speak the Paradox MQTT command protocol **directly** rather than through a backend adapter managed by PxB. The **px-wifi-light-esp8266** (LoLin NodeMCU V3 RGB+White+UV controller) is the reference implementation.

These devices:
- Subscribe to their own `{device_base_topic}/commands` topic and execute light commands autonomously.
- Publish retained state to `{device_base_topic}/state` on connect, on change, and on a heartbeat (default 10 s).
- Use the **same command envelope** as §9a, so operators and dashboards send identical payloads regardless of whether the target is a Hue bulb (via PxB) or an ESP8266 (direct).

### 13.1 Device topic layout

Each device has an operator-defined `base_topic` (e.g. `paradox/lights/stage-left`).

| Topic | Direction | Retained | Description |
|-------|-----------|:--------:|-------------|
| `{base_topic}/commands` | IN | no | Paradox light command payloads |
| `{base_topic}/state` | OUT | **yes** | Full device state, heartbeat + on-change |
| `{base_topic}/events` | OUT | no | Command outcomes |
| `{base_topic}/warnings` | OUT | no | Validation failures, unknown commands |

### 13.2 Command surface

MQTT-native lights accept the **same commands** as §9a, with the subset below confirmed implemented on px-wifi-light. Unrecognised commands receive a `LIGHT_CMD_UNKNOWN` warning and are ignored; they never crash or block.

| Command | Supported | Notes |
|---------|:---------:|-------|
| `on` / `allOn` | ✓ | Defaults to white on if no channels were previously set |
| `off` / `allOff` | ✓ | All channels to zero; channel values preserved for next `on` |
| `setColor` | ✓ | `color: "#rrggbb"` or `{r,g,b}`; optional `brightness` |
| `setBrightness` | ✓ | 0–100; PWM scaler; does not affect white or UV channels |
| `setUV` | ✓ | `level` 0–255; independent UV channel, unaffected by on/off/brightness/scenes |
| `setColorScene` / `scene` | ✓ | See §13.3 for supported scene names |
| `getState` / `getStatus` | ✓ | Force-publishes retained state |
| `identify` | ✓ | 2-second full-white flash then restore |
| `restart` | ✓ | Schedules firmware reboot |
| `setColorTemp` | ✗ | Not applicable — no CCT channel; use a warm/cool scene instead |
| `fade` | ✗ | Not implemented in v0.1 |

### 13.3 Scene names (px-wifi-light)

Scene names are **case-insensitive**. The px-wifi-light maps scenes to its five physical channels (white on/off, UV PWM, R/G/B PWM). The UV channel is **not** controlled by scenes; it retains its current level regardless of scene changes.

| Scene | White | R | G | B | Brightness |
|-------|:-----:|---|---|---|:----------:|
| `off` | off | 0 | 0 | 0 | 100 |
| `white` / `normal` / `brightWhite` | on | 0 | 0 | 0 | 100 |
| `softWhite` | off | 255 | 223 | 223 | 50 |
| `warmWhite` | on | 32 | 8 | 0 | 100 |
| `dim` | off | 255 | 255 | 255 | 30 |
| `coolWhite` | off | 80 | 80 | 255 | 100 |
| `red` | off | 255 | 0 | 0 | 100 |
| `green` | off | 0 | 255 | 0 | 100 |
| `blue` | off | 0 | 0 | 255 | 100 |
| `yellow` | off | 255 | 255 | 0 | 100 |
| `orange` | off | 255 | 128 | 0 | 100 |
| `cyan` | off | 0 | 255 | 255 | 100 |
| `magenta` | off | 255 | 0 | 255 | 100 |
| `purple` | off | 128 | 0 | 255 | 100 |
| `pink` | off | 255 | 64 | 128 | 100 |

### 13.4 State payload (`{base_topic}/state`)

Retained. Published on connect, on any output change, and every `heartbeat_interval_ms` (default 10 000 ms).

```json
{
  "timestamp": "uptime+1234s",
  "application": "px-wifi-light-esp8266",
  "fw_version": "0.1.0",
  "instance": "px-light-AABB",
  "uptime_s": 1234,
  "free_heap": 38192,
  "on": true,
  "white": false,
  "r": 0,
  "g": 255,
  "b": 255,
  "brightness": 100,
  "uv": 0,
  "scene": "cyan",
  "wifi": {
    "sta_connected": true,
    "ap_ip": "192.168.4.1",
    "ap_ssid": "px-light-aabb",
    "ap_clients": 0,
    "sta_ip": "192.168.1.42",
    "sta_ssid": "Paradox",
    "rssi": -58,
    "mac": "AA:BB:CC:DD:EE:FF",
    "mdns": "px-light-aabb.local"
  }
}
```

On unclean disconnect the broker delivers a Last-Will tombstone:

```json
{ "timestamp": "uptime+Ns", "application": "px-wifi-light-esp8266",
  "instance": "px-light-AABB", "status": "offline" }
```

### 13.5 Announce (`paradox/props`)

On each MQTT connection the device publishes to the announce topic (configurable, default `paradox/props`):

```json
{
  "timestamp": "uptime+Ns",
  "application": "px-wifi-light-esp8266",
  "fw_version": "0.1.0",
  "instance": "px-light-AABB",
  "base_topic": "paradox/lights/stage-left",
  "ip": "192.168.1.42",
  "mac": "AA:BB:CC:DD:EE:FF",
  "mdns": "px-light-aabb.local"
}
```

### 13.6 Warning codes

| Code | Meaning |
|------|---------|
| `LIGHT_CMD_UNKNOWN` | `command` name not recognised |
| `LIGHT_CMD_INVALID` | Required parameter missing or malformed |

### 13.7 Integration with PxB light zones

MQTT-native lights can participate in PxB **light zones** if a future `mqtt` backend adapter is implemented. That adapter would subscribe to the zone's `commands` topic and forward (translate if necessary) each command as-is to the device's `{device_base_topic}/commands` topic. Because the command envelope is identical to §9a, no translation is required — the adapter is a pure passthrough.

Until that adapter exists, operators can target these devices directly from any MQTT client or automation script using the commands in §13.2.
