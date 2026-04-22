# PZB Quick Start

**Status:** Placeholder — content finalizes when phase 1 code lands. This outlines the intended flow.

## 1. Install

```bash
cd /opt/paradox/apps/PZB
npm install
```

## 2. Identify Your Radio

```bash
ls -l /dev/serial/by-id/
# pick the stable symlink for your Z-Wave stick, e.g.:
#   usb-Silicon_Labs_HubZ_Smart_Home_Controller_516000D0-if00-port0
```

## 3. Create a Config

Start from the template in [CONFIG_INI.md](CONFIG_INI.md). Save as `/opt/paradox/config/pzb.ini`.

Minimal bootable config (no nodes yet):

```ini
[mqtt]
broker = localhost
client_id = pzb-host
base_topic = paradox/houdini

[zwave]
port = /dev/serial/by-id/usb-Silicon_Labs_HubZ_Smart_Home_Controller_516000D0-if00-port0
```

## 4. First Run (Dev)

```bash
node src/index.js --config /opt/paradox/config/pzb.ini
```

Watch the bridge status:

```bash
mosquitto_sub -v -t 'paradox/houdini/pzb/#'
```

You should see a retained `pzb/status` message every 10s.

## 5. Include a Device

Via MQTT:

```bash
mosquitto_pub -t paradox/houdini/pzb/commands \
  -m '{"command":"startInclusion","radio":"zwave","label":"spell-box"}'
```

Or via CLI:

```bash
./src/cli/index.js include --label spell-box
```

Trigger the physical inclusion on the device (button, magnet tap). PZB will:
- emit a retained discovery notice on `paradox/houdini/pzb/discovered/zwave/<nodeId>`
- append an INI fragment to `discovered.ini` next to your main config
- start publishing events for the node under a temporary `discovered-<n>` topic

## 6. Finalize the Device

Copy the fragment from `discovered.ini` into your main config, edit the placeholders (`type`, `base_topic`, `label`), then restart PZB.

## 7. Verify

```bash
mosquitto_sub -v -t 'paradox/houdini/zwave/spell-box/#'
```

Actuate the sensor and confirm `events` and `state` messages appear.

## 8. Install as a Systemd Service

```
[Unit]
Description=Paradox Z Bridge
After=network-online.target mosquitto.service
Wants=network-online.target
Requires=mosquitto.service

[Service]
Type=simple
User=paradox
WorkingDirectory=/opt/paradox/apps/PZB
ExecStart=/usr/bin/node /opt/paradox/apps/PZB/src/index.js --config /opt/paradox/config/pzb.ini
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pzb
sudo systemctl status pzb
```
