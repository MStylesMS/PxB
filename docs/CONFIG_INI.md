# PxB INI Configuration Reference

**Status:** Draft v0.1.

PxB is configured by a single INI file. Pass the path via `--config` or default location `/etc/pzb/pzb.ini`.

## Section Overview

| Section | Purpose | Cardinality |
|---------|---------|-------------|
| `[mqtt]` | MQTT broker connection + base_topic | 1 |
| `[global]` | Process-wide defaults | 0–1 |
| `[zwave]` | Z-Wave radio endpoint | 0–1 |
| `[zigbee]` | Zigbee radio endpoint | 0–1 |
| `[node:<label>]` | One configured device | 0–N |

## `[mqtt]`

| Key | Type | Required | Default | Description |
|-----|------|:--------:|---------|-------------|
| `broker` | string | yes | — | MQTT broker host/IP |
| `port` | int | no | `1883` | MQTT port |
| `username` | string | no | — | Optional auth |
| `password` | string | no | — | Optional auth |
| `client_id` | string | yes | — | Unique client id (e.g. `pzb-pi5-ssd`) |
| `base_topic` | string | yes | — | Root topic, e.g. `paradox/houdini` |
| `keepalive` | int | no | `60` | Seconds |
| `mqtt_qos` | int | no | `0` | 0/1/2 |

## `[global]`

| Key | Type | Required | Default | Description |
|-----|------|:--------:|---------|-------------|
| `log_level` | string | no | `info` | `error|warn|info|debug|trace` |
| `log_directory` | path | no | — | If set, write logs here (with rotation) |
| `heartbeat_interval` | int (s) | no | `10` | Bridge status republish interval |
| `discovered_base_topic` | string | no | `{base_topic}/pzb/discovered` | Where discovery notices go |
| `discovered_ini_path` | path | no | next to main config | Where INI fragments for new nodes are written |
| `default_discovered_label_prefix` | string | no | `discovered-` | Prefix for auto-assigned labels |

## `[zwave]`

| Key | Type | Required | Default | Description |
|-----|------|:--------:|---------|-------------|
| `enabled` | bool | no | `true` if section present | Disable without removing section |
| `port` | path | yes | — | Stable serial path (e.g. `/dev/serial/by-id/usb-Silicon_Labs_HubZ_...`) |
| `network_key_s0` | hex | no | — | 16-byte S0 key |
| `network_key_s2_unauth` | hex | no | — | S2 unauthenticated |
| `network_key_s2_auth` | hex | no | — | S2 authenticated |
| `network_key_s2_access` | hex | no | — | S2 access control |
| `cache_dir` | path | no | `cache/` relative to config | zwave-js cache location |
| `include_timeout_s` | int | no | `60` | Default inclusion window |

File permissions should be `0600` when keys are present.

## `[zigbee]`

| Key | Type | Required | Default | Description |
|-----|------|:--------:|---------|-------------|
| `enabled` | bool | no | `true` | |
| `port` | path | yes | — | Stable serial path |
| `adapter` | string | no | `ember` | Optional legacy key; when present it must be `ember` |
| `db_path` | path | no | `zigbee.db` next to config | Coordinator state DB |
| `pan_id` | hex | no | auto | |
| `extended_pan_id` | hex | no | auto | |
| `channel` | int | no | `11` | 802.15.4 channel (11–26) |
| `network_key` | hex | no | auto | |
| `include_timeout_s` | int | no | `60` | Default `permitJoin` window |

PxB's Zigbee runtime is pinned to the Ember adapter for Sonoff EFR32MG21 coordinators (for example Dongle-LMG21). Legacy adapter modes are not supported.

When `db_path` is set (or defaulted), PxB also writes two companion files in the same directory:
- Device DB startup snapshot: `<db_path>.backup` (for example `zigbee.db.backup`)
- Coordinator network backup: `zigbee-network.db`

File permissions should be `0600` when `network_key` is set.

## `[node:<label>]`

`<label>` is the operator-chosen short name used in logs and CLI references. Labels must match `[a-z0-9][a-z0-9-]*`.

| Key | Type | Required | Default | Description |
|-----|------|:--------:|---------|-------------|
| `radio` | string | yes | — | `zwave` or `zigbee` |
| `node_id` | int | for Z-Wave | — | Z-Wave node id (1–232) |
| `ieee` | hex | for Zigbee | — | Zigbee IEEE address `0x...` |
| `type` | string | yes | — | `contact`, `relay`, `switch`, `motion` (phase 1: `contact`, `relay`) |
| `base_topic` | string | yes | — | Per-node MQTT root; operator-defined (e.g. `paradox/houdini/zwave/spell-box`) |
| `label` | string | no | `<section label>` | Human-readable label published in state |
| `description` | string | no | — | Free-form note |
| `input_channel` | string | no | `"0"` | Channel id used in event payloads |
| `low_battery_threshold` | int | no | `20` | Percent; below this triggers `LOW_BATTERY` warning |

## Example: Spell-Box Contact Sensor

```ini
[mqtt]
broker = localhost
port = 1883
client_id = pzb-pi5-ssd
base_topic = paradox/houdini

[global]
log_level = info
heartbeat_interval = 10

[zwave]
port = /dev/serial/by-id/usb-Silicon_Labs_HubZ_Smart_Home_Controller_516000D0-if00-port0

[node:spell-box]
radio = zwave
node_id = 3
type = contact
base_topic = paradox/houdini/zwave/spell-box
label = Spell Box
description = Magnetic contact on the spell-box lid
```

## Generated Fragment (Discovery)

When a new node is included, PxB writes a fragment like this into `discovered.ini`:

```ini
# Discovered 2026-04-22T14:40:00Z by PxB v0.1.0
# Review all TODO markers, then move this section into the main config.
[node:discovered-003]
radio = zwave
node_id = 3
type = contact                                          ; TODO: confirm device type
base_topic = paradox/houdini/zwave/discovered-003       ; TODO: choose final topic
label = discovered-003                                  ; TODO: set human label
; description = <fill in>
```

## Validation Rules

- Exactly one of `[zwave]` / `[zigbee]` must be enabled for the bridge to run (phase 1: Z-Wave only).
- Every `[node:...]` must reference a radio that is enabled.
- `base_topic` values across nodes must be unique.
- `node_id` values within a radio must be unique.

Validation failures fail fast at startup with an actionable error message.

## `[light:<label>]`

Light device sections are used for direct network/cloud light backends (`hue`, `wiz`, `lifx`).

| Key | Type | Required | Default | Description |
|-----|------|:--------:|---------|-------------|
| `backend` | string | yes | — | `hue` \| `wiz` \| `lifx` |
| `topic` | string | yes | — | Zone topic root for `{commands,state,warnings,events}` |
| `api_key` | string | backend-specific | — | Required for `hue` and `lifx` |
| `host` | string | backend-specific | — | Required for `hue` and `wiz` |
| `port` | int | no | backend default | Optional per-backend port override |
| `brightness` | int | no | `100` | Default brightness level |
| `hue_profile` | string | no | `color` | Hue rendering mode: `color`, `ct`, or `dim` |
| `scene_map` | string(JSON) | no | built-in defaults | Per-backend scene overrides keyed by scene name |
| `timeout_s` | int | no | `10` | Request timeout |

`scene_map` lets operators tune scene color matching between vendors without code changes. Example:

```ini
[light:room-hue]
backend = hue
topic = paradox/houdini/lights
host = 192.168.1.40
api_key = <hue-app-key>
scene_map = {"cyan":{"on":true,"r":0,"g":210,"b":255,"brightness":72}}
```
