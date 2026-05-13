# DMX Probe Tool

Phase-0 hardware validation script for the USB-to-DMX cable.

## Prerequisites

1. FTDI FT232R cable plugged in (it will enumerate as `/dev/ttyUSBx` — the script auto-detects it).
2. Fixture set to DMX address **1**, mode **6CH DMX**.
3. `paradox` user must be in the `dialout` group (already confirmed).

## Usage

From the PxB repo root:

```bash
# Auto-detect FTDI device
node tools/dmx-probe/probe.js

# Explicit path (use when auto-detect fails)
node tools/dmx-probe/probe.js /dev/ttyUSB3
node tools/dmx-probe/probe.js /dev/serial/by-id/usb-FTDI_FT232R_USB_UART_B002JE1K-if00-port0
```

## What it does

Sends DMX512 frames at ~30 Hz through the following colour sequence (3 s per step):

| Step | Description | CH1 | CH2 R | CH3 G | CH4 B | CH5 W |
|------|-------------|-----|-------|-------|-------|-------|
| 0 | Blackout | 0 | 0 | 0 | 0 | 0 |
| 1 | Master dimmer on | 100 | 0 | 0 | 0 | 0 |
| 2 | Red | 240 | 255 | 0 | 0 | 0 |
| 3 | Green | 240 | 0 | 255 | 0 | 0 |
| 4 | Blue | 240 | 0 | 0 | 255 | 0 |
| 5 | White | 240 | 0 | 0 | 0 | 255 |
| 6 | RGBW soak (33 s) | 240 | 200 | 100 | 100 | 200 |

The last step runs for 33 s so you have time to run `stress -c 4` in a second
terminal and observe whether output flickers under Pi CPU load.

## Tuning the FTDI latency timer

If output flickers, lower the latency timer (default 16 ms → try 4 → try 1):

```bash
echo 4 | sudo tee /sys/bus/usb-serial/devices/ttyUSB3/latency_timer
# Adjust ttyUSBx to match your device
```

## Recording results

After a successful run, fill in the results table in
`docs/pending/PR_DMX_SUPPORT.md` under the **Phase 0 — Results** section.
