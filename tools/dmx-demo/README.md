# DMX Demo

Visual demonstration script that sends MQTT commands to a single DMX light zone, cycling through four sequences:

1. **Fade** — white on→full (2.5 s) then off (2.5 s)
2. **Color cycle** — fade through red → orange → yellow → green → blue → purple → white → off
3. **Strobe ramp** — per color (red/green/blue/white): sweep 0.5 → 15 → 0.5 Hz
4. **Disco** — random colors with Hz ramping 1 → 15 → 1 Hz over 20 s

## Requirements

```bash
cd /opt/paradox/apps/PxB
npm install   # mqtt and yargs are already dependencies
```

## Usage

```bash
node tools/dmx-demo/demo.js

# Custom broker / topic
node tools/dmx-demo/demo.js --broker mqtt://192.168.1.10 --topic paradox/houdini/lights/par1

# Verbose (show every MQTT message)
node tools/dmx-demo/demo.js -v
```

## Options

| Option | Default | Description |
|---|---|---|
| `--broker` | `mqtt://localhost` | MQTT broker URL |
| `--topic` | `paradox/pxb/lights/dmx1` | Light zone base topic |
| `-v, --verbose` | false | Log every command sent |
