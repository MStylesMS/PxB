# Z-Wave Quick Start (PxB)

This guide covers the current Z-Wave path in PxB for migrated PFx relay/input use
cases.

## Current Scope

- Contact sensors publish normalized `open` and `close` events.
- Relay and switch nodes accept `setRelay` and `pulseRelay` commands.
- Output support is currently limited to Binary Switch semantics.

If you need multilevel dimmer support from the old PFx direct path, see
[PR_PFX_BACKEND_MIGRATION_GAPS.md](PR_PFX_BACKEND_MIGRATION_GAPS.md).

## 1. Add a Minimal Config

```ini
[mqtt]
broker     = localhost
client_id  = pxb-houdini
base_topic = paradox/houdini

[zwave]
port = /dev/serial/by-id/usb-Silicon_Labs_HubZ_Smart_Home_Controller_516000D0-if00-port0

[node:spell-box]
radio      = zwave
node_id    = 3
type       = contact
base_topic = paradox/houdini/zwave/spell-box

[node:entry-switch]
radio      = zwave
node_id    = 12
type       = relay
base_topic = paradox/houdini/zwave/entry-switch
```

## 2. Start PxB

```bash
cd /opt/paradox/apps/PxB
node src/index.js --config /opt/paradox/config/pzb.ini
```

## 3. Pair a Node

CLI:

```bash
node src/cli/index.js include --radio zwave --config /opt/paradox/config/pzb.ini
```

MQTT:

```bash
mosquitto_pub -t paradox/houdini/pzb/commands \
  -m '{"command":"startInclusion","radio":"zwave"}'
```

On success, PxB publishes a retained discovery payload on:

```text
paradox/houdini/pzb/discovered/zwave/<node_id>
```

## 4. Observe Input Events

```bash
mosquitto_sub -v -t 'paradox/houdini/zwave/spell-box/#'
```

You should see retained `schema` and `state` payloads plus `open` / `close` event
messages when the sensor changes state.

## 5. Drive a Relay Node

MQTT commands:

```bash
mosquitto_pub -t paradox/houdini/zwave/entry-switch/commands \
  -m '{"command":"setRelay","state":"on"}'

mosquitto_pub -t paradox/houdini/zwave/entry-switch/commands \
  -m '{"command":"pulseRelay","ms":750}'
```

CLI equivalent:

```bash
node src/cli/index.js relay entry-switch on --config /opt/paradox/config/pzb.ini
node src/cli/index.js relay entry-switch pulse --ms 750 --config /opt/paradox/config/pzb.ini
```

## 6. Troubleshooting

| Symptom | Check |
|---------|-------|
| Inclusion stalls after S2 bootstrap | Leave `strategy` unset so PxB uses the safe Insecure default |
| Relay node publishes `COMMAND_UNSUPPORTED` | The device is not exposing Binary Switch CC 37 |
| You need brightness or dimmer control | PxB has not added multilevel switch support yet |
