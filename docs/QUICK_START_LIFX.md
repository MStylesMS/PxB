# LIFX Quick Start (PxB)

This guide covers the direct LIFX cloud backend in PxB.

## Current Scope

- PxB supports LIFX lights through `[light:*]` sections with `backend = lifx`.
- Today the INI path only wires `api_key`, so the active selector is effectively
  the adapter default: `all`.
- In practice, this means one PxB LIFX section currently controls every light the
  token can access.

If you need per-light selectors such as `label:Desk` or `id:d073d5...`, see
[PR_PFX_BACKEND_MIGRATION_GAPS.md](PR_PFX_BACKEND_MIGRATION_GAPS.md).

## 1. Create a LIFX Personal Access Token

Generate a token from the LIFX cloud account used for the installation, then keep
it in the INI file with restrictive permissions.

## 2. Add a PxB Config Section

```ini
[mqtt]
broker     = localhost
client_id  = pxb-houdini
base_topic = paradox/houdini

[light:lifx-main]
backend    = lifx
topic      = paradox/houdini/lights/lifx-main
api_key    = your-lifx-token
brightness = 80
timeout_s  = 10
```

## 3. Start PxB

```bash
cd /opt/paradox/apps/PxB
node src/index.js --config /opt/paradox/config/pzb.ini
```

## 4. Send Commands

```bash
mosquitto_pub -t paradox/houdini/lights/lifx-main/commands \
  -m '{"command":"scene","scene":"warmWhite"}'

mosquitto_pub -t paradox/houdini/lights/lifx-main/commands \
  -m '{"command":"setColor","color":"#ff4400","brightness":70}'

mosquitto_pub -t paradox/houdini/lights/lifx-main/commands \
  -m '{"command":"setColorTemp","kelvin":3200,"brightness":75}'

mosquitto_pub -t paradox/houdini/lights/lifx-main/commands \
  -m '{"command":"off"}'
```

## 5. Observe State and Warnings

```bash
mosquitto_sub -v -t 'paradox/houdini/lights/lifx-main/#'
```

## 6. Custom Scene Map

```ini
[light:lifx-main]
backend   = lifx
topic     = paradox/houdini/lights/lifx-main
api_key   = your-lifx-token
scene_map = {"red":{"on":true,"r":255,"g":40,"b":40,"brightness":65}}
```

## 7. Troubleshooting

| Symptom | Check |
|---------|-------|
| `LIFX_INIT_FAILED` | Verify the token can reach `https://api.lifx.com/v1/lights/all` |
| Commands affect too many bulbs | Current PxB config does not wire LIFX selectors; the adapter defaults to `all` |
| Cloud requests time out | Check outbound HTTPS connectivity from the PxB host |
