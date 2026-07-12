# WiZ Smart Plug Quick Start (PxB)

This guide covers the WiZ smart plug/socket backend in PxB.

## Current Scope

- PxB supports WiZ smart plugs through `[switch:*]` sections with `backend = wiz`.
- WiZ plugs are single-channel on/off relays (no dimming/color), so they live in
  the switch domain alongside Shelly rather than in `[light:*]`.
- Control is direct over the LAN via UDP (port `38899`) — no cloud dependency.
  On/off uses the WiZ `setState` method; status is read with `getPilot`.
- The command vocabulary matches the Shelly switch backend (`setRelay`, `pulse`,
  `allOn`, `allOff`) so downstream consumers treat both identically.

> WiZ **bulbs** (dimming/color) still use `[light:*]` with `backend = wiz` — see
> `docs/QUICK_START_WIZ.md`. Use this guide only for WiZ **plugs/sockets**.

## 1. Add a PxB Config Section

```ini
[mqtt]
broker     = localhost
client_id  = pxb-houdini
base_topic = paradox/houdini

[switch:wiz-fan]
backend   = wiz
topic     = paradox/houdini/switches/wiz-fan
host      = 10.0.0.131
port      = 38899
timeout_s = 5
```

Find the plug's IP in the WiZ app (or via your router). A static/reserved DHCP
lease is recommended so the IP does not change.

## 2. Start PxB

```bash
cd /opt/paradox/apps/PxB
node src/index.js --config /opt/paradox/config/pzb.ini
```

## 3. Send Commands

Turn the plug on or off:

```bash
mosquitto_pub -t paradox/houdini/switches/wiz-fan/commands \
  -m '{"command":"setRelay","on":true}'

mosquitto_pub -t paradox/houdini/switches/wiz-fan/commands \
  -m '{"command":"setRelay","on":false}'
```

Pulse the plug on for 750 ms:

```bash
mosquitto_pub -t paradox/houdini/switches/wiz-fan/commands \
  -m '{"command":"pulse","duration_ms":750}'
```

`allOn` / `allOff` behave the same as `setRelay` since a plug is single-channel:

```bash
mosquitto_pub -t paradox/houdini/switches/wiz-fan/commands \
  -m '{"command":"allOn"}'
```

## 4. Observe State and Warnings

```bash
mosquitto_sub -v -t 'paradox/houdini/switches/wiz-fan/#'
```

State payloads report `type: "wiz-plug"`, a connectivity `status`, a top-level
`state` of `"on"` or `"off"` (channel 0), and the single-channel relay list,
e.g. `{"state":"on","relays":[{"id":0,"on":true}]}`.

## 5. Notes

- WiZ plugs are single-channel. A `channel` value in a command payload is
  accepted but ignored (PxB publishes a `WIZ_PLUG_CHANNEL_UNSUPPORTED` warning
  and acts on channel `0`).
- PxB polls plug state every 5 s. After 3 consecutive failed polls it marks the
  device `degraded` and publishes a `WIZ_PLUG_DEVICE_UNREACHABLE` warning.

## 6. Troubleshooting

| Symptom | Check |
|---------|-------|
| `WIZ_PLUG_INIT_FAILED` | Verify the plug IP is reachable and still using UDP port `38899` |
| `WIZ_PLUG_DEVICE_UNREACHABLE` | The plug is not answering UDP status polls; check Wi-Fi and IP address |
| Commands do nothing | Confirm the plug is on the same LAN/subnet as PxB (UDP is not routed across VLANs by default) |
