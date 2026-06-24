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
node src/index.js --config /opt/paradox/config/pxb.ini
```

Or, when installed as a service: `sudo systemctl start pxb`.

> **Topic note:** All bridge-level control happens on `{base_topic}/pxb/commands`
> (e.g. `paradox/houdini/pxb/commands`). Per-node telemetry lives under each
> node's own operator-defined `base_topic` (e.g. `paradox/houdini/spell-box`).
> Inclusion/exclusion are **bridge** commands — never send them to a node's
> `/commands` topic, or the node handler rejects them with `UNKNOWN_COMMAND`.

## 3. Pair a Node

Keep an eye on the log in another terminal so you can see the node join:

```bash
journalctl -u pxb -f
```

CLI:

```bash
node src/cli/index.js include --radio zwave --config /opt/paradox/config/pxb.ini
```

MQTT:

```bash
mosquitto_pub -h 127.0.0.1 -t paradox/houdini/pxb/commands \
  -m '{"command":"startInclusion","radio":"zwave","timeout_s":90}'
```

Then trigger the device's pairing action (a single press or triple-tap, per the
device manual). The log should show `Discovered node zwave-<id>` followed by
`Z-Wave node <id> interview completed`, and PxB publishes a retained discovery
payload on:

```text
paradox/houdini/pxb/discovered/zwave/<node_id>
```

Copy the assigned `node_id` into the matching `[node:*]` section in the INI and
restart PxB so the node binds to its configured topics.

## 4. Observe Input Events

Subscribe to the node's own `base_topic` (the value from its `[node:*]` section),
not a fixed tree:

```bash
mosquitto_sub -h 127.0.0.1 -v -t 'paradox/houdini/spell-box/#'
```

You should see retained `schema` and `state` payloads plus `open` / `close` event
messages when the sensor changes state. Actuate the sensor (separate and rejoin
the magnet) to confirm — the log prints `Node "spell-box" contact → opened` /
`→ closed` and `state.source` reads `zwave-node-<id>` for the node you just paired.

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
node src/cli/index.js relay entry-switch on --config /opt/paradox/config/pxb.ini
node src/cli/index.js relay entry-switch pulse --ms 750 --config /opt/paradox/config/pxb.ini
```

## 5b. Re-pair a Sensor That Won't Join

If inclusion runs but **no node joins** (the window stays open then closes with
no `Discovered node` line), the device usually still believes it belongs to
another network. Reset it via exclusion first, then include:

1. Start exclusion mode:

   ```bash
   mosquitto_pub -h 127.0.0.1 -t paradox/houdini/pxb/commands \
     -m '{"command":"startExclusion","radio":"zwave","timeout_s":90}'
   ```

2. Trigger the device's pairing/reset action. A **single long blink** (and the
   log returning to `idle` before the timeout) confirms the device was reset.

3. Run the inclusion step from section 3. The device now joins with a fresh
   `node_id`.

4. Update the INI `node_id` and restart PxB.

## 6. Troubleshooting

| Symptom | Check |
|---------|-------|
| Log shows `UNKNOWN_COMMAND: startInclusion` | You sent inclusion to a node topic. Send it to the **bridge** topic `{base_topic}/pxb/commands`, not `{node.base_topic}/commands`. |
| `mosquitto_pub`/`mosquitto_sub` to a `pzb/...` topic sees nothing | The bridge namespace is `pxb`, not `pzb`. Use `{base_topic}/pxb/...`. |
| Inclusion starts then drops back to `idle` within ~1s | The controller is busy — usually a previous node stuck `interviewing`. Check `pxb/state.nodes.interviewing`; remove the dead node with `removeFailedNode` (or `pxb remove-failed-node <id>`), then retry. |
| Inclusion window stays open but no node joins | The device still thinks it's paired. Run the exclude-then-include flow in section 5b. |
| Sensor paired but `open`/`close` never arrive on the node topic | The INI `node_id` doesn't match the joined node. Confirm the discovered `node_id`, update the `[node:*]` section, and restart PxB. Verify `state.source` matches the new `zwave-node-<id>`. |
| Inclusion stalls after S2 bootstrap | Leave `strategy` unset so PxB uses the safe Insecure default |
| Relay node publishes `COMMAND_UNSUPPORTED` | The device is not exposing Binary Switch CC 37 |
| You need brightness or dimmer control | PxB has not added multilevel switch support yet |
