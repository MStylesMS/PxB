# DMX Fixture Profiles (PxB)

PxB ships twelve built-in fixture profiles and supports one-off `custom` fixtures
defined directly in the INI. Every profile is a small validated JS object in
`src/dmx/profiles/` and is loaded at startup by `src/dmx/profiles/index.js`.

Profiles declare:
- **`channels`** — ordered slot array; index 0 = DMX offset 0 from the fixture's
  start address.
- **`capabilities`** — what command surface is available; the adapter gates
  commands against this set.
- **`defaults`** (optional) — channel values written on every `on` command to
  hold mode/strobe/speed pins at safe values.

---

## Built-in Profiles

### `dimmer` — 1 channel

| Offset | Slot | Description |
|---|---|---|
| 1 | dimmer | Intensity 0–255 |

**Capabilities:** `dimmer`

Suitable for: single-channel dimmers, fog machines, smoke machines, LED strips
with a single control channel.

---

### `rgb` — 3 channels

| Offset | Slot | Description |
|---|---|---|
| 1 | red | Red 0–255 |
| 2 | green | Green 0–255 |
| 3 | blue | Blue 0–255 |

**Capabilities:** `dimmer`, `color`

Suitable for: basic RGB par cans, LED strips with separate R/G/B control.
Brightness is achieved by scaling all three channels proportionally (no master
dimmer channel).

---

### `rgbw` — 4 channels

| Offset | Slot | Description |
|---|---|---|
| 1 | red | Red 0–255 |
| 2 | green | Green 0–255 |
| 3 | blue | Blue 0–255 |
| 4 | white | White 0–255 |

**Capabilities:** `dimmer`, `color`, `colorTemp`

Suitable for: RGBW LED panels and par cans. The white channel is not
automatically populated by `setColor` — mix it via `scene_map` overrides or a
future `setColorTemp` implementation.

---

### `rgba` — 4 channels

| Offset | Slot | Description |
|---|---|---|
| 1 | red | Red 0–255 |
| 2 | green | Green 0–255 |
| 3 | blue | Blue 0–255 |
| 4 | amber | Amber 0–255 |

**Capabilities:** `dimmer`, `color`

Suitable for: RGBA LED par cans where amber replaces white for warmer tones.

---

### `rgbaw` — 5 channels

| Offset | Slot | Description |
|---|---|---|
| 1 | red | Red 0–255 |
| 2 | green | Green 0–255 |
| 3 | blue | Blue 0–255 |
| 4 | amber | Amber 0–255 |
| 5 | white | White 0–255 |

**Capabilities:** `dimmer`, `color`, `colorTemp`

Suitable for: 5-in-1 LED fixtures (common in stage wash lights).

---

### `rgbawuv` — 6 channels

| Offset | Slot | Description |
|---|---|---|
| 1 | red | Red 0–255 |
| 2 | green | Green 0–255 |
| 3 | blue | Blue 0–255 |
| 4 | amber | Amber 0–255 |
| 5 | white | White 0–255 |
| 6 | uv | UV / Ultraviolet 0–255 |

**Capabilities:** `dimmer`, `color`, `colorTemp`

Suitable for: 6-in-1 LED par cans with UV LED bank. The UV channel is not
automatically driven by `setColor` — use `scene_map` or fixture-specific logic.

---

### `par-7ch` — 7 channels

| Offset | Slot | Description |
|---|---|---|
| 1 | dimmer | Master dimmer 0–255 |
| 2 | red | Red 0–255 |
| 3 | green | Green 0–255 |
| 4 | blue | Blue 0–255 |
| 5 | strobe | Strobe speed (0 = off) |
| 6 | mode | Program/mode selector (0 = static) |
| 7 | speed | Program speed (0 = slowest/off) |

**Capabilities:** `dimmer`, `color`, `strobe`, `mode`

**Defaults on `on`:** `mode = 0`, `speed = 0`, `strobe = 0`

Suitable for: typical 7-channel PAR LED fixtures commonly used in escape rooms.
The master dimmer is channel 1; color commands set R/G/B at full values and the
dimmer controls brightness. Mode, strobe, and speed are automatically pinned to
safe defaults on every `on` command to prevent unexpected program or strobe
activation.

---

### `mover-basic` — 3 channels

| Offset | Slot | Description |
|---|---|---|
| 1 | pan | Pan position 0–255 |
| 2 | tilt | Tilt position 0–255 |
| 3 | dimmer | Intensity 0–255 |

**Capabilities:** `pan`, `tilt`, `dimmer`

Suitable for: minimal moving heads with pan, tilt, and a single intensity
channel. Color control is not available. Pan/tilt commands (`setPan`,
`setTilt`) are reserved for Phase 6 — they return `DMX_CMD_UNSUPPORTED` in the
current release.

---

## Effect Profiles (Phase 5)

Effect profiles carry the `effect` capability and are intended for use with
`[effect:<label>]` INI sections and `DmxEffectAdapter`. They respond to the
`burst`, `pulse`, `stop`, and `setIntensity` commands rather than the light
command surface.

> **Custom fixtures are not supported for effect devices.** Stick to one of
> the four built-in profiles; if your device has an unusual channel layout,
> request a new built-in profile.

---

### `fogger-1ch` — 1 channel

| Offset | Slot | Description |
|---|---|---|
| 1 | dimmer | Output intensity — 0 = off, 255 = maximum fog |

**Capabilities:** `dimmer`, `effect`

Suitable for: single-channel fog machines, basic atmospheric foggers.

---

### `fogger-2ch` — 2 channels

| Offset | Slot | Description |
|---|---|---|
| 1 | dimmer | Output intensity — 0 = off, 255 = maximum fog |
| 2 | speed  | Fan speed — 0 = off, 255 = maximum air projection |

**Capabilities:** `dimmer`, `effect`

Configure fan speed with `fan_speed` in the INI section (default `0`).
Set to 0 for a drifting cloud; raise to 100–200 for a directed jet.

Suitable for: 2-channel fog machines where the second channel controls fan
thrust.

---

### `strobe-2ch` — 2 channels

| Offset | Slot | Description |
|---|---|---|
| 1 | strobe | Strobe rate — 0 = off, 1 = slowest, 255 = fastest |
| 2 | dimmer | Intensity / brightness — 0 = off, 255 = full brightness |

**Capabilities:** `strobe`, `dimmer`, `effect`

Configure the strobe rate with `strobe_rate` in the INI section (default `128`
= medium speed). On `burst`/`pulse`, the strobe channel is set to
`strobe_rate` and the dimmer channel is set proportional to `intensity`.

Suitable for: 2-channel LED or halogen strobe lights.

---

### `hazer-2ch` — 2 channels

| Offset | Slot | Description |
|---|---|---|
| 1 | dimmer | Haze output — 0 = off, 255 = maximum haze |
| 2 | speed  | Fan dispersion speed — 0 = off, 255 = maximum |

**Capabilities:** `dimmer`, `effect`

For a subtle ambient haze, try `intensity = 25` and `fan_speed = 60` in the
INI. The hazer runs continuously until `stop` is sent; use `setIntensity`
rather than `burst` for continuous atmospheric fill.

Suitable for: 2-channel atmospheric hazers (fine mist, not dense fog).

---

## Custom Fixture

If your fixture doesn't match any built-in profile, define the channel mapping
inline in the INI file with `fixture = custom` and a `channels` key:

```ini
[light:unusual-par]
backend    = dmx
topic      = paradox/room/lights/unusual-par
fixture    = custom
address    = 10
channels   = dimmer:1,red:2,green:3,blue:4,strobe:5
brightness = 90
```

**`channels` format:** comma-separated `slot:offset` pairs. Offsets are
1-based relative to the fixture's `address` and must be contiguous (no gaps).

**Valid slot names:** `dimmer`, `red`, `green`, `blue`, `white`, `amber`, `uv`,
`strobe`, `mode`, `speed`, `pan`, `tilt`, `gobo`

Capabilities are inferred automatically from the slots present:
- Any of `red`/`green`/`blue`/`uv` → `color`
- Any of `white`/`amber` → `colorTemp`
- `dimmer` → `dimmer`
- `strobe` → `strobe`
- `pan` → `pan`, `tilt` → `tilt`, `gobo` → `gobo`, `mode`/`speed` → `mode`

Custom fixture validation runs at startup; PxB will refuse to load a config with
an invalid channel spec.

---

## Adding Your Own Profile to the Library

For a fixture you reuse across multiple rooms, add a file in
`src/dmx/profiles/<name>.js`:

```js
'use strict';

module.exports = {
    name:         'my-wash',
    channels:     ['dimmer', 'red', 'green', 'blue', 'white', 'amber'],
    capabilities: ['dimmer', 'color', 'colorTemp'],
};
```

Then require it in `src/dmx/profiles/index.js` by adding `'my-wash'` to the
`BUILT_INS` loop array. Run `npm run test:unit` to validate via the schema
checker.
