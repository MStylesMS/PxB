# Quick Start: DMX Effects (Foggers, Strobes, Hazers)

PxB Phase 5 adds a dedicated `DmxEffectAdapter` that sits alongside the DMX
light adapters on the same universe. Effects are declared as `[effect:<label>]`
INI sections and expose a timer-safe command surface (`burst`, `pulse`, `stop`,
`setIntensity`) over MQTT.

---

## Prerequisites

- A `[dmx]` section in your INI (either `opendmx` or `enttec-pro` interface).
- One or more DMX-addressed effect devices patched to known start addresses.

---

## INI Setup

```ini
[mqtt]
broker = localhost

[dmx]
enabled    = true
interface  = enttec-pro
port       = /dev/serial/by-id/usb-ENTTEC_DMX_USB_PRO_EN123456-if00-port0

; --- Effects ---

[effect:fogger]
backend    = dmx
topic      = paradox/houdini/effects/fogger
fixture    = fogger-2ch     ; CH1 = intensity, CH2 = fan speed
address    = 1
max_run_ms = 3000           ; reject any burst longer than 3 s (safety ceiling)
intensity  = 90             ; default intensity if burst omits the param
fan_speed  = 100            ; CH2 value while firing

[effect:strobe]
backend     = dmx
topic       = paradox/houdini/effects/strobe
fixture     = strobe-2ch    ; CH1 = strobe rate, CH2 = intensity
address     = 3
max_run_ms  = 2000
strobe_rate = 160           ; CH1 value while firing (0 = off, 255 = fastest)

[effect:hazer]
backend    = dmx
topic      = paradox/houdini/effects/hazer
fixture    = hazer-2ch      ; CH1 = haze output, CH2 = fan
address    = 5
max_run_ms = 10000
intensity  = 30
fan_speed  = 80
```

---

## Supported Fixtures

| Fixture name  | Channels | Description |
|---|---|---|
| `fogger-1ch` | 1 | CH1: intensity |
| `fogger-2ch` | 2 | CH1: intensity, CH2: fan speed |
| `strobe-2ch` | 2 | CH1: strobe rate, CH2: intensity |
| `hazer-2ch`  | 2 | CH1: haze output, CH2: fan dispersion |

See [DMX_FIXTURES.md](DMX_FIXTURES.md) for full channel layouts.

---

## Command Reference

All commands are JSON published to `{effect.topic}/commands`.

### Fire a burst (fire-and-forget)

```json
{ "command": "burst", "duration_ms": 1500 }
```

```json
{ "command": "burst", "duration_ms": 1500, "intensity": 75 }
```

The device fires for `duration_ms` milliseconds then zeros automatically.
`duration_ms` must be ≤ `max_run_ms`; otherwise the command is rejected with
an `EFFECT_DURATION_CAPPED` warning.

`pulse` is an alias for `burst`.

### Stop immediately

```json
{ "command": "stop" }
```

Zeroes all channels and cancels any running timer.

### Continuous output

```json
{ "command": "setIntensity", "intensity": 50 }
```

Sets the level with no timer — stays on until `stop` is sent. Useful for
continuous atmospheric hazing.

### Query state

```json
{ "command": "getStatus" }
```

Causes PxB to re-publish current state to `{effect.topic}/state`.

---

## State and Events

State (`{effect.topic}/state`, retained):

```json
{
  "on":         true,
  "intensity":  90,
  "expires_at": "2026-05-12T10:00:01.500Z",
  "fixture":    "fogger-2ch",
  "address":    1,
  "timestamp":  "2026-05-12T10:00:00.000Z"
}
```

Events (`{effect.topic}/events`, not retained):

| Event | When |
|---|---|
| `burst-started` | Burst begins |
| `burst-ended`   | Timer auto-stops the device |
| `stopped`       | Manual stop (device was running) |
| `intensity-updated` | `setIntensity` processed |

---

## Using with PxO

Add an MQTT command to your EDN sequence:

```edn
{:command "burst"
 :zone    "paradox/houdini/effects/fogger"
 :params  {:duration_ms 2000 :intensity 80}}
```

Or stop all effects at puzzle reset:

```edn
{:command "stop"
 :zone    "paradox/houdini/effects/fogger"}
{:command "stop"
 :zone    "paradox/houdini/effects/strobe"}
```

---

## Safety Notes

- **`max_run_ms` is the primary safety gate.** Set it to the longest burst you
  want to allow — PxB will reject anything longer, protecting equipment.
- Effect adapters zero their channels on dispose / process shutdown. If PxB
  restarts mid-burst, the device stops within one DMX frame after reconnect.
- The DMX universe is shared between lights and effects. Address ranges must
  not overlap; verify your fixture patch list matches the INI addresses.
