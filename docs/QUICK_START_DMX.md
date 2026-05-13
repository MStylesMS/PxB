# DMX Quick Start (PxB)

This guide covers driving DMX512 fixtures directly from PxB using an OpenDMX
(FTDI FT232R) USB-to-DMX dongle.

## Current Scope (Phase 3)

- PxB drives a single DMX universe per device via `[dmx]` + one or more
  `[light:*]` sections with `backend = dmx`.
- Eight built-in fixture profiles: `dimmer`, `rgb`, `rgbw`, `rgba`, `rgbaw`,
  `rgbawuv`, `par-7ch`, `mover-basic`. See `docs/DMX_FIXTURES.md` for full channel
  layouts.
- Custom fixtures via `fixture = custom` + a `channels` key (see §2 below).
- Phase 4 adds Enttec Pro support.
- For grouped control, fan DMX fixtures through a `[light-zone:*]` section
  exactly as with other backends.

## Prerequisites

- OpenDMX dongle (FTDI FT232R) connected via USB.
- udev rule installed so the Pi has consistent device path (see README).
- `dmx` attribute set on the device: `setserial /dev/ttyUSB0 divisor 6` is
  **not** needed — PxB uses baud-rate switching, not the kernel DMX driver.

## 1. Choose a Fixture Profile

All built-in profiles are described fully in [docs/DMX_FIXTURES.md](DMX_FIXTURES.md).
A summary:

| `fixture` value | Channels | Notes |
|---|---|---|
| `dimmer` | 1 | Single intensity channel |
| `rgb` | 3 | R / G / B |
| `rgbw` | 4 | R / G / B / White |
| `rgba` | 4 | R / G / B / Amber |
| `rgbaw` | 5 | R / G / B / Amber / White |
| `rgbawuv` | 6 | R / G / B / Amber / White / UV |
| `par-7ch` | 7 | Master dimmer + R/G/B + strobe + mode + speed |
| `mover-basic` | 3 | Pan / Tilt / Dimmer |
| `custom` | varies | Define channels in INI (see §2c) |

## 2. Add PxB Config Sections

### 2a. Single dimmer (fog machine at address 3)

```ini
[mqtt]
broker     = localhost
client_id  = pxb-houdini
base_topic = paradox/houdini

[dmx]
interface  = opendmx
port       = /dev/serial/by-id/usb-FTDI_FT232R_USB_UART_B002JE1K-if00-port0
refresh_hz = 30

[light:fog-dimmer]
backend    = dmx
topic      = paradox/houdini/lights/fog
fixture    = dimmer
address    = 3
brightness = 100
```

### 2b. RGB + RGBW par cans with a zone group

```ini
[dmx]
interface  = opendmx
port       = /dev/serial/by-id/usb-FTDI_FT232R_USB_UART_B002JE1K-if00-port0
refresh_hz = 30

[light:stage-rgb]
backend    = dmx
topic      = paradox/houdini/lights/stage-rgb
fixture    = rgb
address    = 1
brightness = 100

[light:accent-rgbw]
backend    = dmx
topic      = paradox/houdini/lights/accent-rgbw
fixture    = rgbw
address    = 4          ; channels 4–7
brightness = 80

[light-zone:dmx-room]
topic      = paradox/houdini/lights/dmx-room
devices    = stage-rgb,accent-rgbw
```

### 2c. Custom fixture

If your fixture doesn't match any built-in profile, define the channel mapping
directly in the INI. The `channels` key is a comma-separated list of
`slot:offset` pairs; offsets are 1-based relative to `address` and must be
contiguous.

```ini
[light:unusual-par]
backend    = dmx
topic      = paradox/houdini/lights/unusual-par
fixture    = custom
address    = 10
channels   = dimmer:1,red:2,green:3,blue:4,strobe:5
brightness = 90
```

Valid slot names: `dimmer`, `red`, `green`, `blue`, `white`, `amber`, `uv`,
`strobe`, `mode`, `speed`, `pan`, `tilt`, `gobo`.

## 3. Start PxB

```bash
cd /opt/paradox/apps/PxB
node src/index.js --config /opt/paradox/config/pzb.ini
```

## 4. Send Commands

Single fixture:

```bash
# Turn on at default brightness
mosquitto_pub -t paradox/houdini/lights/stage-rgb/commands \
  -m '{"command":"on"}'

# Set a named colour scene
mosquitto_pub -t paradox/houdini/lights/stage-rgb/commands \
  -m '{"command":"setColorScene","scene":"cyan"}'

# Set an explicit RGB colour
mosquitto_pub -t paradox/houdini/lights/stage-rgb/commands \
  -m '{"command":"setColor","color":{"r":0,"g":200,"b":255},"brightness":80}'

# Set colour with a hex string
mosquitto_pub -t paradox/houdini/lights/stage-rgb/commands \
  -m '{"command":"setColor","color":"#00C8FF","brightness":75}'

# Adjust brightness only (preserves current colour)
mosquitto_pub -t paradox/houdini/lights/stage-rgb/commands \
  -m '{"command":"setBrightness","brightness":40}'

# Turn off
mosquitto_pub -t paradox/houdini/lights/stage-rgb/commands \
  -m '{"command":"off"}'
```

Group fan-out:

```bash
mosquitto_pub -t paradox/houdini/lights/dmx-room/commands \
  -m '{"command":"setColorScene","scene":"normal"}'
```

Dimmer fixture (single-channel):

```bash
mosquitto_pub -t paradox/houdini/lights/fog/commands \
  -m '{"command":"setBrightness","brightness":60}'
```

## 5. Observe State and Warnings

```bash
mosquitto_sub -v -t 'paradox/houdini/lights/stage-rgb/#'
mosquitto_sub -v -t 'paradox/houdini/lights/dmx-room/#'
```

State topic (`{topic}/state`) is retained. Warnings (`{topic}/warnings`) are
emitted for unsupported commands (`fade`, `setColorTemp`) and unknown scenes —
never silently dropped.

## 6. Unsupported Commands

| Command | Behaviour |
|---|---|
| `setColorTemp` | Warning code `DMX_CMD_UNSUPPORTED`; use `setColor` or a named scene |
| `fade` | Warning code `DMX_CMD_UNSUPPORTED`; use `setBrightness` for immediate level changes |

## 7. Built-in Scenes

Available for `setColorScene` / `scene`:

`normal`, `dim`, `red`, `green`, `blue`, `yellow`, `orange`, `purple`, `pink`,
`cyan`, `magenta`, `white`, `softWhite`, `brightWhite`, `warmWhite`, `coolWhite`, `off`

Override any scene per fixture with `scene_map` in the INI (JSON string):

```ini
[light:stage-rgb]
backend    = dmx
topic      = paradox/houdini/lights/stage-rgb
fixture    = rgb
address    = 1
scene_map  = {"cyan":{"r":0,"g":210,"b":255,"brightness":72}}
```

## 8. Notes

- A single `[dmx]` universe section is required when any light uses `backend = dmx`.
  If the `[dmx]` section is absent or `enabled = false`, PxB degrades the
  fixture to `UnavailableOutputAdapter` and logs a startup warning.
- Channel addresses are 1-based and must fit within the 512-slot universe. PxB
  validates this at startup and refuses to load an overlapping or out-of-range config.
- The DMX refresh loop runs at `refresh_hz` (1–44 Hz, default 30). The OpenDMX
  interface sends a complete 513-byte frame on every tick.
- Phase 4 adds Enttec Pro USB Pro support.
- See [docs/DMX_FIXTURES.md](DMX_FIXTURES.md) for per-fixture channel tables.
