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
| `[dmx]` | DMX512 universe output (singleton, label "default") | 0–1 |
| `[dmx:<label>]` | Named DMX512 universe (multi-universe) | 0–N |
| `[node:<label>]` | One configured device | 0–N |
| `[light:<label>]` | One light fixture / Hue bridge / WiZ / LIFX device | 0–N |
| `[light-zone:<label>]` | Fan-out group across multiple lights | 0–N |
| `[switch:<label>]` | One Shelly relay | 0–N |
| `[effect:<label>]` | One DMX effect device (fogger / strobe / hazer) | 0–N |

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

## `[dmx]` / `[dmx:<label>]`

Configures one or more DMX512 output universes.

- **`[dmx]`** — singleton universe (label `"default"`). Compatible with all existing configs. Only one `[dmx]` section per file.
- **`[dmx:<label>]`** — named universe. Multiple named sections are supported. `<label>` must match `[a-z0-9][a-z0-9-]*`. You cannot mix `[dmx]` and `[dmx:default]` in the same file.

When multiple universes are configured, `[light:*]` and `[effect:*]` sections may declare which universe to use via the `universe` key (default: `"default"`).

| Key | Type | Required | Default | Description |
|-----|------|:--------:|---------|-------------|
| `enabled` | bool | no | `true` | Disable without removing section |
| `interface` | string | yes | — | `opendmx` (direct FTDI) or `enttec-pro` (Enttec USB Pro / DMXKing ultraDMX2) |
| `port` | path | yes | — | Serial device path. Prefer stable `/dev/serial/by-id/usb-FTDI_FT232R...` form |
| `refresh_hz` | int | no | `30` | Frame repeat rate (1–44 Hz). Actual Hz may be lower due to baud-switch overhead |
| `universe_size` | int | no | `512` | Slot count sent per frame (24–512) |
| `ftdi_latency_ms` | int | no | `4` | FTDI latency timer in ms (opendmx only). Set to 4 or lower; the udev rule in `config/udev/99-ftdi-dmx.rules` applies this on plug-in |

**opendmx:** uses the baud-rate-switch BREAK method (open at 76800 baud, send `0x00`, reopen at 250000 baud). The `port.set({brk})` method is unreliable on ftdi_sio + Pi5 and must **not** be used.

**enttec-pro / DMXKing ultraDMX2 Pro:** uses the Enttec Open Protocol label-6 envelope at 57600 baud 8N1. Hardware validation checklist: `docs/pending/PR_DMX_SUPPORT.md §8`.

**Single-universe example (existing style):**

```ini
[dmx]
enabled     = true
interface   = opendmx
port        = /dev/serial/by-id/usb-FTDI_FT232R_USB_UART_B002JE1K-if00-port0
refresh_hz  = 30
```

**Multi-universe example:**

```ini
[dmx:stage]
interface   = opendmx
port        = /dev/serial/by-id/usb-FTDI_FT232R_USB_UART_stage
refresh_hz  = 30

[dmx:foyer]
interface   = enttec-pro
port        = /dev/serial/by-id/usb-ENTTEC_DMX_USB_PRO_foyer
refresh_hz  = 25

[light:par1]
backend     = dmx
topic       = paradox/houdini/lights/par1
fixture     = par-7ch
address     = 1
universe    = stage            # ← which [dmx:<label>] universe to use (default: "default")
```

## `[effect:<label>]`

Declares one DMX effect output device (fogger, strobe, or hazer). Requires a `[dmx]` section. Uses `DmxEffectAdapter` with a timer-safe command surface separate from the light adapters.

`<label>` must match `[a-z0-9][a-z0-9-]*`.

| Key | Type | Required | Default | Description |
|-----|------|:--------:|---------|-------------|
| `backend` | string | yes | — | Must be `dmx` |
| `topic` | string | yes | — | MQTT topic root for this device |
| `fixture` | string | yes | — | `fogger-1ch`, `fogger-2ch`, `strobe-2ch`, or `hazer-2ch` |
| `address` | int | no | `1` | DMX start address, 1-based (1–512) |
| `max_run_ms` | int | no | `4000` | Safety ceiling: any burst/pulse with `duration_ms` above this value is rejected with a warning |
| `intensity` | int | no | `100` | Default output intensity for burst commands that omit the `intensity` param (0–100) |
| `strobe_rate` | int | no | `128` | Strobe channel value for `strobe-2ch` (0–255; 0 = off, 255 = fastest) |
| `fan_speed` | int | no | `0` | Speed channel value for `fogger-2ch` and `hazer-2ch` (0–255) |

Example:

```ini
[dmx]
enabled    = true
interface  = enttec-pro
port       = /dev/serial/by-id/usb-ENTTEC_DMX_USB_PRO_EN123456-if00-port0

[effect:fogger]
backend    = dmx
topic      = paradox/houdini/effects/fogger
fixture    = fogger-2ch
address    = 1
max_run_ms = 3000
intensity  = 90
fan_speed  = 120

[effect:strobe]
backend     = dmx
topic       = paradox/houdini/effects/strobe
fixture     = strobe-2ch
address     = 3
max_run_ms  = 2000
strobe_rate = 180
```

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
| `hue_target_type` | string | no | `all` | Hue target selector: `all`, `group`, or `light` |
| `hue_target_id` | string | with `group`/`light` | — | Hue group id or light id for scoped targeting |
| `scene_map` | string(JSON) | no | built-in defaults | Per-backend scene overrides keyed by scene name |
| `timeout_s` | int | no | `10` | Request timeout |
| `fixture` | string | dmx only | — | Fixture profile: `dimmer` or `rgb` (Phase 2); more in Phase 3 |
| `address` | int | dmx only | `1` | DMX start address for this fixture (1–512) |
| `positions` | string(JSON) | dmx mover only | `{"home":{"pan":128,"tilt":128}}` | Named pan/tilt positions for `moveTo` command |
| `universe` | string | dmx only | `"default"` | Which `[dmx:<label>]` universe this fixture belongs to |

`positions` is a JSON object mapping position names to `{ pan, tilt, speed? }` objects. The `home` position is always available (default `pan: 128, tilt: 128`) and can be overridden. Example:

```ini
[light:stage-mover]
backend = dmx
topic = paradox/houdini/lights/mover
fixture = mover-8ch
address = 1
positions = {"home":{"pan":128,"tilt":128},"stage-left":{"pan":60,"tilt":100},"stage-right":{"pan":190,"tilt":100},"center":{"pan":128,"tilt":90}}
```

`scene_map` lets operators tune scene color matching between vendors without code changes. Example:

```ini
[light:room-hue]
backend = hue
topic = paradox/houdini/lights
host = 192.168.1.40
api_key = <hue-app-key>
hue_target_type = group
hue_target_id = 7
scene_map = {"cyan":{"on":true,"r":0,"g":210,"b":255,"brightness":72}}
```

`hue_target_type = all` targets the bridge-wide all-lights action. Use
`group` or `light` with `hue_target_id` to scope the adapter to a Hue room/zone
group or a single Hue light.

For `backend = dmx` fixtures, pair the `[light:*]` section with a `[dmx]` universe section:

```ini
[dmx]
interface = opendmx
port = /dev/serial/by-id/usb-FTDI_FT232R_USB_UART_B002JE1K-if00-port0
refresh_hz = 30

[light:stage-rgb]
backend = dmx
topic = paradox/houdini/lights/stage-rgb
fixture = rgb
address = 1
brightness = 100
```

Supported commands and caveats are listed in `docs/MQTT_API.md §9a`.

## `[light-zone:<label>]`

Light zones are generic fan-out groups built from named `[light:*]` members.

| Key | Type | Required | Default | Description |
|-----|------|:--------:|---------|-------------|
| `topic` | string | yes | — | Zone topic root for `{commands,state,warnings,events}` |
| `devices` | csv | yes | — | Comma-separated list of `[light:*]` labels |

Example:

```ini
[light:hue-room]
backend = hue
topic = paradox/houdini/lights/hue-room
host = 192.168.1.40
api_key = <hue-app-key>
hue_target_type = group
hue_target_id = 7

[light:wiz-desk]
backend = wiz
topic = paradox/houdini/lights/wiz-desk
host = 10.0.0.84

[light-zone:stage]
topic = paradox/houdini/lights/stage
devices = hue-room,wiz-desk
```

Light zones may mix vendors. PxB fans commands out to each member adapter and
expects each backend to apply the parts it supports while publishing warnings for
unsupported requests.
