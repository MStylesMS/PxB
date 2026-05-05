# WiZ Quick Start (PxB)

This guide covers the direct WiZ LAN backend in PxB.

## Current Scope

- PxB supports WiZ lights through `[light:*]` sections with `backend = wiz`.
- Each light section targets one WiZ bulb IP.
- For grouped control, define multiple `[light:*]` sections and fan out through a
  `[light-zone:*]` section.

## 1. Add PxB Config Sections

Single bulb:

```ini
[mqtt]
broker     = localhost
client_id  = pxb-houdini
base_topic = paradox/houdini

[light:wiz-84]
backend    = wiz
topic      = paradox/houdini/lights/wiz-84
host       = 10.0.0.84
brightness = 80
```

Grouped room control:

```ini
[light:wiz-84]
backend = wiz
topic   = paradox/houdini/lights/wiz-84
host    = 10.0.0.84

[light:wiz-109]
backend = wiz
topic   = paradox/houdini/lights/wiz-109
host    = 10.0.0.109

[light-zone:wiz-room]
topic   = paradox/houdini/lights/wiz-room
devices = wiz-84,wiz-109
```

## 2. Start PxB

```bash
cd /opt/paradox/apps/PxB
node src/index.js --config /opt/paradox/config/pzb.ini
```

## 3. Send Commands

Single bulb:

```bash
mosquitto_pub -t paradox/houdini/lights/wiz-84/commands \
  -m '{"command":"scene","scene":"cyan"}'

mosquitto_pub -t paradox/houdini/lights/wiz-84/commands \
  -m '{"command":"setBrightness","brightness":45}'

mosquitto_pub -t paradox/houdini/lights/wiz-84/commands \
  -m '{"command":"setColor","color":"#00A0FF","brightness":75}'

mosquitto_pub -t paradox/houdini/lights/wiz-84/commands \
  -m '{"command":"setColorTemp","kelvin":3500,"brightness":80}'
```

Group fan-out:

```bash
mosquitto_pub -t paradox/houdini/lights/wiz-room/commands \
  -m '{"command":"scene","scene":"normal"}'
```

## 4. Observe State and Warnings

```bash
mosquitto_sub -v -t 'paradox/houdini/lights/wiz-84/#'
mosquitto_sub -v -t 'paradox/houdini/lights/wiz-room/#'
```

## 5. Custom Scene Map

```ini
[light:wiz-84]
backend   = wiz
topic     = paradox/houdini/lights/wiz-84
host      = 10.0.0.84
scene_map = {"normal":{"state":true,"temp":4000,"dimming":70},"off":{"state":false}}
```

## 6. Notes

- WiZ `fade` is accepted, but duration is not native to the protocol. PxB applies
  the target level immediately and publishes a limitation warning.
- The old PFx `bulb_ips = ...` fallback group shortcut is not available in PxB.
  Use named member devices plus `[light-zone:*]`.

## 7. Troubleshooting

| Symptom | Check |
|---------|-------|
| `WIZ_INIT_FAILED` | Verify the bulb IP is reachable and still using UDP port `38899` |
| `WIZ_DEVICE_UNREACHABLE` | The bulb is not answering UDP status polls; check Wi-Fi and IP address |
| Group topic reports partial failures | One or more member lights failed; inspect the member `.../warnings` topics |
