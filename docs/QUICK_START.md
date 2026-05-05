# PxB Quick Start

This page covers the baseline bridge bring-up flow. For migrated PFx backends,
see the backend-specific quick starts in this directory:

- [QUICK_START_HUE.md](QUICK_START_HUE.md)
- [QUICK_START_WIZ.md](QUICK_START_WIZ.md)
- [QUICK_START_LIFX.md](QUICK_START_LIFX.md)
- [QUICK_START_SHELLY.md](QUICK_START_SHELLY.md)
- [QUICK_START_ZWAVE.md](QUICK_START_ZWAVE.md)
- [QUICK_START_ZIGBEE.md](QUICK_START_ZIGBEE.md)

If you want the current parity gaps versus the legacy PFx quick starts, see
[PR_PFX_BACKEND_MIGRATION_GAPS.md](PR_PFX_BACKEND_MIGRATION_GAPS.md).

## 1. Install

```bash
cd /opt/paradox/apps/PxB
npm install
```

> **Requires Node.js 18+ and a working zwave-js-compatible USB stick.**

## 2. Identify Your Radio

Always use a stable symlink — never `/dev/ttyUSBn` (enumeration order varies):

```bash
ls -l /dev/serial/by-id/
# Example output:
#   usb-Silicon_Labs_HubZ_Smart_Home_Controller_516000D0-if00-port0 -> ../../ttyUSB0
```

## 3. Create a Config

Save as `/opt/paradox/config/pzb.ini`.

**Minimal bootable config** (no nodes, no security keys):

```ini
[mqtt]
broker     = localhost
client_id  = pzb-houdini
base_topic = paradox/houdini

[zwave]
port = /dev/serial/by-id/usb-Silicon_Labs_HubZ_Smart_Home_Controller_516000D0-if00-port0
```

**With a configured contact sensor:**

```ini
[mqtt]
broker     = localhost
client_id  = pzb-houdini
base_topic = paradox/houdini

[zwave]
port              = /dev/serial/by-id/usb-Silicon_Labs_HubZ_Smart_Home_Controller_516000D0-if00-port0
network_key_s0    = 0xAABBCCDDEEFF00112233445566778899
network_key_s2_unauth = 0x...

[node:spell-box]
radio      = zwave
node_id    = 3
type       = contact
base_topic = paradox/houdini/zwave/spell-box
```

See [CONFIG_INI.md](CONFIG_INI.md) for the full key reference.

## 4. First Run (Dev)

```bash
node src/index.js --config /opt/paradox/config/pzb.ini
```

Watch the bridge status:

```bash
mosquitto_sub -v -t 'paradox/houdini/pzb/#'
```

You should see a retained `pzb/state` message within 10 seconds.

## 5. CLI Commands (Phase 1)

```bash
# Print current bridge status (reads retained MQTT message)
node src/cli/index.js status --config /opt/paradox/config/pzb.ini

# List all configured nodes (reads config file only, no broker needed)
node src/cli/index.js list-nodes --config /opt/paradox/config/pzb.ini

# Show help
node src/cli/index.js help
```

If PxB is installed globally via `npm link` or the `pzb` binary is in PATH:

```bash
pzb status     --config /opt/paradox/config/pzb.ini
pzb list-nodes --config /opt/paradox/config/pzb.ini
```

## 6. Force a Status Publish (MQTT Command)

```bash
mosquitto_pub -t paradox/houdini/pzb/commands \
  -m '{"command":"getNetworkStatus"}'
```

PxB will immediately re-publish the current `pzb/state` payload.

## 7. Verify Contact Sensor Events

Actuate a configured contact sensor (open/close). Check:

```bash
mosquitto_sub -v -t 'paradox/houdini/zwave/spell-box/#'
```

Expected retained messages (subscribe once, you'll see the latest of each):
- `.../schema` — one-shot descriptor published at PxB startup; tells consumers the node's type, topics, and payload shape.
- `.../events` — short event payload per state change, e.g. `{"event":"open"}` / `{"event":"close"}`.
- `.../state`  — flat telemetry snapshot published only when something changes:
  ```json
  {
    "state": "closed",
    "ts": "2026-04-22T23:10:36.936Z",
    "battery":   { "level": 62, "ts": "..." },
    "reachable": { "value": true, "ts": "..." },
    "tamper":    null,
    "source":    "zwave-node-3"
  }
  ```

See [MQTT_API.md §8](MQTT_API.md) for the full state / schema reference.

## 8. Include / Exclude a Node

**Default inclusion strategy is Insecure (`2`).** PxB does not yet wire the S2 user
callbacks (`grantSecurityClasses`, `validateDSKAndEnterPIN`, `abort`), so a default-strategy
S2 bootstrap will abort and leave the node half-included and unreachable. Unless you
have a specific reason to use S0 / S2, leave `strategy` unset.

```bash
# Start inclusion (Insecure — default)
mosquitto_pub -t paradox/houdini/pzb/commands \
  -m '{"command":"startInclusion","radio":"zwave"}'

# Then perform the device's pairing gesture (typically 3 quick presses).

# Stop early if needed
mosquitto_pub -t paradox/houdini/pzb/commands \
  -m '{"command":"stopInclusion","radio":"zwave"}'

# Exclude a node (same gesture during exclusion window)
mosquitto_pub -t paradox/houdini/pzb/commands \
  -m '{"command":"startExclusion","radio":"zwave"}'
```

Optional overrides (advanced; only use if you have a reason):

```jsonc
{"command":"startInclusion","radio":"zwave","strategy":4}   // Security S2 (needs user callbacks — will fail today)
{"command":"startInclusion","radio":"zwave","strategy":3}   // Security S0
{"command":"startInclusion","radio":"zwave","strategy":0}   // Default (prefers S2 — will fail today)
{"command":"startInclusion","radio":"zwave","timeout_s":120}
```

On success PxB publishes a `paradox/<base>/pzb/discovered/zwave/<node_id>` message
with a ready-to-paste INI fragment.

## 9. Install as a Systemd Service

Copy the bundled template:

```bash
sudo cp /opt/paradox/apps/PxB/config/systemd/pzb.service /etc/systemd/system/pzb.service
# Edit ExecStart and --config path if your config is in a different location
sudo nano /etc/systemd/system/pzb.service
```

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pzb
sudo systemctl status pzb
```

Check logs:

```bash
journalctl -u pzb -f
```

## 10. Serial Port Permission

On Raspberry Pi OS the `paradox` user must be in the `dialout` group:

```bash
sudo usermod -aG dialout paradox
# Log out and back in (or reboot) for the change to take effect
```

## 11. Troubleshooting

| Symptom | Check |
|---------|-------|
| `Config file not found` | Verify `--config` path is absolute or correct relative path |
| `pzb/state` never appears | Confirm `broker` and `base_topic` in INI match what you subscribe to |
| Z-Wave driver fails to start | Check `port` path exists and the user has read/write access |
| Node events missing | Confirm `node_id` in INI matches the Z-Wave controller's assignment |
| `ZWAVE_DRIVER_ERROR` warnings | Non-fatal; driver will reconnect with exponential backoff |
| Node stuck `interviewing`, `has failed S2 bootstrapping` in zwave-js log | Node was included with strategy `0` or `4`; S2 user callbacks not yet implemented. Exclude and re-include with the default (Insecure) strategy. |
