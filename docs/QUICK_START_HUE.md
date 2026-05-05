# Hue Quick Start (PxB)

This guide covers the current Philips Hue path in PxB.

## Current Scope

- PxB supports direct Hue control via `[light:*]` sections with `backend = hue`.
- The current adapter drives the Hue bridge's `groups/0/action` all-lights group for
  scene, on/off, brightness, color, and color-temperature commands.
- If you need per-light targeting, PxB currently exposes that only through the
  advanced `setLight` command with a raw Hue `lightId`.

If you need room/zone/resource targeting like the old PFx guide documented, see
[PR_PFX_BACKEND_MIGRATION_GAPS.md](PR_PFX_BACKEND_MIGRATION_GAPS.md).

## 1. Create a Hue API Key

Press the bridge link button, then request a v1 API key:

```bash
curl -s -X POST http://192.168.1.100/api \
  -H 'Content-Type: application/json' \
  -d '{"devicetype":"pxb#bridge"}'
```

Example success payload:

```json
[{"success":{"username":"your-hue-app-key"}}]
```

## 2. Add a PxB Config Section

```ini
[mqtt]
broker     = localhost
client_id  = pxb-houdini
base_topic = paradox/houdini

[light:hue-main]
backend     = hue
topic       = paradox/houdini/lights/hue-main
host        = 192.168.1.100
api_key     = your-hue-app-key
hue_profile = color
brightness  = 80
```

`hue_profile` modes:

- `color` - use Hue XY color for scenes and `setColor`
- `ct` - prefer color temperature for white-capable bulbs
- `dim` - brightness only

## 3. Start PxB

```bash
cd /opt/paradox/apps/PxB
node src/index.js --config /opt/paradox/config/pzb.ini
```

## 4. Send Commands

```bash
mosquitto_pub -t paradox/houdini/lights/hue-main/commands \
  -m '{"command":"scene","scene":"softWhite"}'

mosquitto_pub -t paradox/houdini/lights/hue-main/commands \
  -m '{"command":"setColor","color":"#00DCFF","brightness":75}'

mosquitto_pub -t paradox/houdini/lights/hue-main/commands \
  -m '{"command":"setColorTemp","kelvin":3000,"brightness":70}'

mosquitto_pub -t paradox/houdini/lights/hue-main/commands \
  -m '{"command":"off"}'
```

Advanced per-light command:

```bash
mosquitto_pub -t paradox/houdini/lights/hue-main/commands \
  -m '{"command":"setLight","lightId":"3","on":true,"brightness":200}'
```

## 5. Observe State and Warnings

```bash
mosquitto_sub -v -t 'paradox/houdini/lights/hue-main/#'
```

Useful topics:

- `.../state` - retained Hue snapshot
- `.../events` - command and scene events
- `.../warnings` - init, command, or connectivity warnings

## 6. Built-in Scene Names

PxB aligns these scene names across Hue, WiZ, and LIFX:

- `normal`
- `dim`
- `red`
- `blue`
- `green`
- `yellow`
- `orange`
- `purple`
- `pink`
- `cyan`
- `magenta`
- `white`
- `softWhite`
- `brightWhite`
- `warmWhite`
- `coolWhite`
- `off`

You can override any of them with `scene_map`:

```ini
[light:hue-main]
backend     = hue
topic       = paradox/houdini/lights/hue-main
host        = 192.168.1.100
api_key     = your-hue-app-key
hue_profile = color
scene_map   = {"cyan":{"on":true,"r":0,"g":210,"b":255,"brightness":72}}
```

## 7. Troubleshooting

| Symptom | Check |
|---------|-------|
| `HUE_INIT_FAILED` | Verify `host` and `api_key` by calling `http://<bridge>/api/<key>/lights` manually |
| Commands work but affect more lights than expected | Current PxB Hue path targets the bridge all-lights group |
| `HUE_CMD_LIMITATION` | `fade` currently applies an immediate brightness change; timed fades are not implemented |
