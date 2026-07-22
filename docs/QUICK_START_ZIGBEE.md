# Zigbee Quick Start (PxB)

This guide covers the current Zigbee path in PxB for migrated PFx relay/input use
cases.

## Current Scope

- PxB expects the Ember adapter path on a Sonoff EFR32MG21-class coordinator.
- Contact sensors publish normalized events and retained state.
- Relay and switch nodes accept `setRelay` and `pulseRelay` through the `genOnOff`
  cluster.

If you are still on the HUSBZB-1 Zigbee radio, read
[PR_ZIGBEE_FIX.md](PR_ZIGBEE_FIX.md) before proceeding.

## 1. Add a Minimal Config

```ini
[mqtt]
broker     = localhost
client_id  = pxb-houdini
base_topic = paradox/houdini

[zigbee]
port      = /dev/serial/by-id/usb-ITEAD_SONOFF_Zigbee_3.0_USB_Dongle_Plus_V2-if00-port0
baud_rate = 115200

[node:front-door]
radio      = zigbee
ieee       = 0x00124b0026aa55bb
type       = contact
base_topic = paradox/houdini/zigbee/front-door

[node:relay-box]
radio      = zigbee
ieee       = 0x00124b0026aa55cc
type       = relay
base_topic = paradox/houdini/zigbee/relay-box
```

## 2. Start PxB

```bash
cd /opt/paradox/apps/PxB
node src/index.js --config /opt/paradox/config/pzb.ini
```

## 3. Pair a Node

CLI:

```bash
node src/cli/index.js include --radio zigbee --timeout-s 90 --config /opt/paradox/config/pzb.ini
```

MQTT:

```bash
mosquitto_pub -t paradox/houdini/pxb/commands \
  -m '{"command":"startInclusion","radio":"zigbee","timeout_s":90}'
```

Promote the discovered fragment from:

```text
paradox/houdini/pxb/discovered/zigbee/<ieee-tail>
```

into a named `[node:*]` section once you know the final topic and type.

## 4. Observe Input Events

```bash
mosquitto_sub -v -t 'paradox/houdini/zigbee/front-door/#'
```

## 5. Drive a Relay Node

```bash
mosquitto_pub -t paradox/houdini/zigbee/relay-box/commands \
  -m '{"command":"setRelay","state":"on"}'

mosquitto_pub -t paradox/houdini/zigbee/relay-box/commands \
  -m '{"command":"pulseRelay","ms":500}'
```

CLI equivalent:

```bash
node src/cli/index.js relay relay-box off --config /opt/paradox/config/pzb.ini
```

## 6. Notes

- Zigbee exclusion mode is not exposed the way Z-Wave exclusion is. Use inclusion,
  refresh, and remove-node flows instead.
- Output support is currently limited to `genOnOff` on/off and pulse. Brightness,
  color, and color-temperature output are not yet wired.

## 7. Troubleshooting

| Symptom | Check |
|---------|-------|
| Zigbee driver fails immediately | Ensure the coordinator is an Ember-compatible Sonoff EFR32MG21 path |
| Joined devices never finish interviewing on HUSBZB-1 | Replace the coordinator; see `PR_ZIGBEE_FIX.md` |
| Relay node publishes `COMMAND_UNSUPPORTED` | The device does not expose a controllable `genOnOff` endpoint |
