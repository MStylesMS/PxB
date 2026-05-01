# PxB — Paradox Bridge

PxB is a **simple, focused Z-Wave / Zigbee / Thread to MQTT bridge** for the Paradox escape-room platform. It owns the radio(s) on a Linux host, publishes device events and state over MQTT in the Paradox topic contract, and accepts pairing and output commands via MQTT or CLI.

## What It Does

- Connects to Z-Wave and Zigbee USB radios; Zigbee is targeted at Sonoff EFR32MG21 coordinators (Dongle-LMG21 class) on the Ember adapter path.
- Publishes a **retained** heartbeat/lifecycle state for the bridge process itself on a fixed interval (default 10s).
- Publishes **retained on-change** node events and state for contact sensors, relays, etc.
- Accepts commands over MQTT (pairing, relay control, diagnostics) and an equivalent CLI.
- On discovery, emits an INI fragment ready to drop into the downstream consumer (PFx) with sensible defaults and clearly marked placeholders.

## Why PxB Exists

PFx was evolving toward direct Z-Wave and Zigbee ownership. That coupled the radio stack lifecycle to the media controller lifecycle, made fault isolation hard, and required PFx to grow into device management territory. PxB takes that responsibility, lets PFx stay focused on media/effects, and gives every other Paradox component (PxO, Web UIs, PxT) a single stable MQTT contract for radio devices.

## Project Status

**Early scaffold.** Design locked. No runtime implementation yet. See [docs/PR_PZB_INITIAL.md](docs/PR_PZB_INITIAL.md) for the phased plan and checklist.

## Documentation

| Document | Purpose |
|----------|---------|
| [docs/SPEC.md](docs/SPEC.md) | Functional specification |
| [docs/MQTT_API.md](docs/MQTT_API.md) | MQTT topic/message contract |
| [docs/CONFIG_INI.md](docs/CONFIG_INI.md) | INI configuration reference |
| [docs/QUICK_START.md](docs/QUICK_START.md) | Install and first-run guide |
| [docs/Scaffold_Summary.md](docs/Scaffold_Summary.md) | Initial repo layout and what each file is for |
| [docs/PR_PZB_INITIAL.md](docs/PR_PZB_INITIAL.md) | Phased implementation plan with model-routing tags |

## Paradox Family

PxB is one product in a set that composes a full escape-room stack:

- **PFx** — media/audio/lights/relays controller
- **PxO** — game orchestration engine
- **PxC** — configurable clock application framework
- **PxT** — player terminal kiosk
- **Pio** — GPIO-to-MQTT bridge
- **PxB** — Z-Wave / Zigbee / Thread bridge (this project)

All components share the same MQTT topic convention: `{baseTopic}/{commands|events|state|warnings}`.
