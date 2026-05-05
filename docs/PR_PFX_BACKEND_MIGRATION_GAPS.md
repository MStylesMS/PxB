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

### 1. Hue resource targeting is narrower

Legacy PFx docs exposed `hue_resource_id` and `hue_resource_type` for room, zone,
and single-light targeting.

Current PxB behavior:

- `HueAdapter` drives Hue scenes and most commands through `groups/0/action`
- `[light:*]` config only wires `host`, `api_key`, `hue_profile`, and generic light keys
- no INI support exists for `hue_resource_id` or `hue_resource_type`

Impact: PxB Hue is currently bridge-wide by default, not room/zone-scoped.

### 2. LIFX selector support is not wired through config

`LifxAdapter` supports a runtime `selector`, but the INI schema/loader does not
pass one through.

Current PxB behavior:

- adapter falls back to `selector = all`
- one `[light:*]` LIFX section controls every light visible to the token

Impact: per-bulb selectors such as `label:Desk` or `id:d073d5...` are not usable
from the INI today.

### 3. WiZ grouping is narrower

Legacy PFx WiZ docs described a fallback group-only shortcut using `bulb_ips`.

Current PxB behavior:

- grouping requires named member lights plus `[light-zone:*]`
- no `bulb_ips` shortcut exists in the loader or schema

Impact: operators must define one `[light:*]` per bulb before grouping.

### 4. WiZ passthrough mode was not migrated

Legacy PFx WiZ docs also exposed `backend = passthrough`, where PFx normalized
light commands and forwarded them to another MQTT topic.

Current PxB behavior:

- only direct `wiz` light control exists for WiZ in the active loader/runtime
- no generic passthrough light backend is available

Impact: installs that depended on MQTT-forwarded light commands need a different
bridge layer or a future PxB passthrough adapter.

### 5. Shelly support is relay-only right now

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

### 6. Shelly input mapping has not landed

Legacy PFx Shelly input docs covered Plus i4 style `input_topic` and `input_map`
event fan-out.

Current PxB behavior:

- Shelly switch adapter does not consume input MQTT topics
- no Shelly input adapter exists
- no `input_map` equivalent is wired for Shelly-originated events

Impact: Shelly input-only devices are not yet migrated.

### 7. Shelly config wiring is still minimal

The active Shelly adapter knows about runtime `gen` and `channel`, but the INI
schema/loader does not expose those keys.

Current PxB behavior:

- generation is auto-detected only
- default channel is implicitly `0`
- non-zero channels must be passed in each command payload

Impact: multi-channel installs work, but the config model is weaker than the
adapter surface.

### 8. Z-Wave outputs are on/off only

Legacy PFx Z-Wave docs described `zwave_type = multilevel_switch` and brightness
control.

Current PxB behavior:

- node commands only support `setRelay` and `pulseRelay`
- low-level Z-Wave command helper only calls Binary Switch CC 37

Impact: multilevel switch and dimmer support are still open.

### 9. Zigbee outputs are on/off only

Legacy PFx Zigbee docs described `setBrightness`, `setColor`, and
`setColorTemp` flows for direct light devices.

Current PxB behavior:

- node commands only support `setRelay` and `pulseRelay`
- low-level Zigbee command helper only calls `genOnOff`

Impact: level/color/color-temperature Zigbee output support is still open.

### 10. Generic input/output aggregators are scaffolded but not active

PxB has `src/inputs/aggregator.js` and `src/outputs/aggregator.js`, but the main
runtime does not currently parse or initialize `[inputs:*]` and `[outputs:*]`
sections.

Impact:

- no aggregated input zone equivalent is available yet
- no generic routed output zone is available yet

## Recommended Follow-up PRs

1. Wire `selector` into the LIFX INI schema and docs.
2. Add scoped Hue targeting (`resource_id`, `resource_type`) or a simpler PxB
   selector model.
3. Expand Shelly beyond relay control: input devices first, then dimmer/RGBW.
4. Add Z-Wave multilevel switch commands.
5. Add Zigbee level/color command support.
6. Either finish `[inputs:*]` / `[outputs:*]` runtime wiring or remove the dead
   schema entries until they are ready.
