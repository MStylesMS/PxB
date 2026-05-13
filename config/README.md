# config/

## test-full-stack.ini

A reference INI that mirrors the adapter setup exercised by the fault-isolation soak test
(`npm run test:soak`). The soak test wires adapters programmatically, so this file is **not
used by Jest** — it exists as a human-readable cross-reference and as a starting point for
running the same adapter mix against real hardware.

To use it against hardware:
1. Replace the `192.0.2.x` placeholder addresses with real host IPs.
2. Fill in any `api_key` values.
3. Run: `node src/index.js --config config/test-full-stack.ini --log-level debug`

## systemd/pxb.service

Systemd unit file for running PxB as a service on Linux (Raspberry Pi or desktop).

To install:
```bash
sudo cp config/systemd/pxb.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable pxb
sudo systemctl start pxb
```

The unit expects:
- Node.js at `/usr/bin/node`
- Config at `/opt/paradox/config/pzb.ini` (override via a drop-in or edit `ExecStart` directly)
- A `paradox` user and group
- `mosquitto.service` running before PxB starts

Logs go to the journal: `journalctl -u pxb -f`
