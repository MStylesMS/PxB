# PZB Quick Start

## 1. Install

```bash
cd /opt/paradox/apps/PZB
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

You should see a retained `pzb/status` message within 10 seconds.

## 5. CLI Commands (Phase 1)

```bash
# Print current bridge status (reads retained MQTT message)
node src/cli/index.js status --config /opt/paradox/config/pzb.ini

# List all configured nodes (reads config file only, no broker needed)
node src/cli/index.js list-nodes --config /opt/paradox/config/pzb.ini

# Show help
node src/cli/index.js help
```

If PZB is installed globally via `npm link` or the `pzb` binary is in PATH:

```bash
pzb status     --config /opt/paradox/config/pzb.ini
pzb list-nodes --config /opt/paradox/config/pzb.ini
```

## 6. Force a Status Publish (MQTT Command)

```bash
mosquitto_pub -t paradox/houdini/pzb/commands \
  -m '{"command":"getNetworkStatus"}'
```

PZB will immediately re-publish the current `pzb/status` payload.

## 7. Verify Contact Sensor Events

Actuate a configured contact sensor (open/close). Check:

```bash
mosquitto_sub -v -t 'paradox/houdini/zwave/spell-box/#'
```

Expected messages:
- `paradox/houdini/zwave/spell-box/events` — `{"input":"0","event":"open","source":"zwave-node-3",...}`
- `paradox/houdini/zwave/spell-box/state`  — node state snapshot (retained)

## 8. Install as a Systemd Service

Copy the bundled template:

```bash
sudo cp /opt/paradox/apps/PZB/config/systemd/pzb.service /etc/systemd/system/pzb.service
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

## 9. Serial Port Permission

On Raspberry Pi OS the `paradox` user must be in the `dialout` group:

```bash
sudo usermod -aG dialout paradox
# Log out and back in (or reboot) for the change to take effect
```

## 10. Troubleshooting

| Symptom | Check |
|---------|-------|
| `Config file not found` | Verify `--config` path is absolute or correct relative path |
| `pzb/status` never appears | Confirm `broker` and `base_topic` in INI match what you subscribe to |
| Z-Wave driver fails to start | Check `port` path exists and the user has read/write access |
| Node events missing | Confirm `node_id` in INI matches the Z-Wave controller's assignment |
| `ZWAVE_DRIVER_ERROR` warnings | Non-fatal; driver will reconnect with exponential backoff |
