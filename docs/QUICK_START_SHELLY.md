# Shelly Quick Start (PxB)

This guide covers the current Shelly path in PxB.

## Current Scope

- PxB supports Shelly devices through `[switch:*]` sections with `backend = shelly`.
- The active implementation is relay/switch oriented: on, off, pulse, all-on, and
  all-off through the local HTTP API.
- Generation is auto-detected at runtime.
- Command payloads can target non-zero relay channels explicitly with `channel`.

If you need the legacy PFx Shelly `dimmer`, `rgbw`, or `input` profiles, see
[PR_PFX_BACKEND_MIGRATION_GAPS.md](PR_PFX_BACKEND_MIGRATION_GAPS.md).

## 1. Add a PxB Config Section

```ini
[mqtt]
broker     = localhost
client_id  = pxb-houdini
base_topic = paradox/houdini

[switch:shelly-main]
backend   = shelly
topic     = paradox/houdini/switches/shelly-main
host      = 10.0.0.151
port      = 80
timeout_s = 5
```

## 2. Start PxB

```bash
cd /opt/paradox/apps/PxB
node src/index.js --config /opt/paradox/config/pzb.ini
```

## 3. Send Commands

Turn one relay on or off:

```bash
mosquitto_pub -t paradox/houdini/switches/shelly-main/commands \
  -m '{"command":"setRelay","on":true}'

mosquitto_pub -t paradox/houdini/switches/shelly-main/commands \
  -m '{"command":"setRelay","on":false}'
```

Pulse relay `0` for 750 ms:

```bash
mosquitto_pub -t paradox/houdini/switches/shelly-main/commands \
  -m '{"command":"pulse","channel":0,"duration_ms":750}'
```

Turn every discovered relay on the device on or off:

```bash
mosquitto_pub -t paradox/houdini/switches/shelly-main/commands \
  -m '{"command":"allOn"}'

mosquitto_pub -t paradox/houdini/switches/shelly-main/commands \
  -m '{"command":"allOff"}'
```

## 4. Observe State and Warnings

```bash
mosquitto_sub -v -t 'paradox/houdini/switches/shelly-main/#'
```

State payloads include the detected generation and current relay list.

## 5. Notes

- The current INI schema does not expose a default `channel` key, so channel `0`
  is the implicit default. Use `channel` in the command payload when you need a
  different relay.
- The current INI schema also does not expose a forced generation override; PxB
  auto-detects Gen1 versus Gen2/Plus.

## 6. Troubleshooting

| Symptom | Check |
|---------|-------|
| `SHELLY_INIT_FAILED` | Verify the host answers local HTTP requests |
| Commands do nothing on Gen2 | Confirm the device exposes `/rpc/Switch.Set` and `/rpc/Shelly.GetDeviceInfo` |
| Multi-relay device only changes one channel | Include `channel` in the command payload |
