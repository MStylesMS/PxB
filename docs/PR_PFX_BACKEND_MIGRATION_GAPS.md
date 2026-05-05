# PR: PxB Backend Migration Gaps vs Legacy PFx Quick Starts

This document tracks the remaining parity gaps between the legacy PFx backend
quick starts and the current PxB implementation.

## Summary

PxB now owns the migrated backend surface for:

- direct Hue lights
- direct WiZ lights
- direct LIFX lights
- Shelly relay/switch control
- Z-Wave node inputs and relay outputs
- Zigbee node inputs and relay outputs

The migration is not full feature parity yet. The gaps below are the ones still
visible when comparing PxB against the legacy PFx quick-start surface.

## Gaps

### 1. LIFX selector support is not wired through config

`LifxAdapter` supports a runtime `selector`, but the INI schema/loader does not
pass one through.

Current PxB behavior:

- adapter falls back to `selector = all`
- one `[light:*]` LIFX section controls every light visible to the token

Impact: per-bulb selectors such as `label:Desk` or `id:d073d5...` are not usable
from the INI today.

### 2. Shelly support is relay-only right now

Legacy PFx Shelly docs covered:

- `profile = switch`
- `profile = dimmer`
- `profile = rgbw`
- `profile = input`

Current PxB behavior:

- only `[switch:*] backend = shelly` exists
- commands are relay-oriented: `setRelay`, `pulse`, `allOn`, `allOff`
- no brightness, dimming, color, or RGBW control surface exists

Impact: Shelly dimmer and RGBW migrations are still open.

### 3. Shelly input mapping has not landed

Legacy PFx Shelly input docs covered Plus i4 style `input_topic` and `input_map`
event fan-out.

Current PxB behavior:

- Shelly switch adapter does not consume input MQTT topics
- no Shelly input adapter exists
- no `input_map` equivalent is wired for Shelly-originated events

Impact: Shelly input-only devices are not yet migrated.

### 4. Shelly config wiring is still minimal

The active Shelly adapter knows about runtime `gen` and `channel`, but the INI
schema/loader does not expose those keys.

Current PxB behavior:

- generation is auto-detected only
- default channel is implicitly `0`
- non-zero channels must be passed in each command payload

Impact: multi-channel installs work, but the config model is weaker than the
adapter surface.

### 5. Z-Wave outputs are on/off only

Legacy PFx Z-Wave docs described `zwave_type = multilevel_switch` and brightness
control.

Current PxB behavior:

- node commands only support `setRelay` and `pulseRelay`
- low-level Z-Wave command helper only calls Binary Switch CC 37

Impact: multilevel switch and dimmer support are still open.

### 6. Zigbee outputs are on/off only

Legacy PFx Zigbee docs described `setBrightness`, `setColor`, and
`setColorTemp` flows for direct light devices.

Current PxB behavior:

- node commands only support `setRelay` and `pulseRelay`
- low-level Zigbee command helper only calls `genOnOff`

Impact: level/color/color-temperature Zigbee output support is still open.

## Recommended Follow-up PRs

1. Wire `selector` into the LIFX INI schema and docs.
2. Expand Shelly beyond relay control: input devices first, then dimmer/RGBW.
3. Add Z-Wave multilevel switch commands.
4. Add Zigbee level/color command support.
