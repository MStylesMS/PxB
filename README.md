# PxB — Paradox Bridge

PxB is a **simple, focused Z-Wave / Zigbee / Thread to MQTT bridge** for the Paradox escape-room platform. It owns the radio(s) on a Linux host, publishes device events and state over MQTT in the Paradox topic contract, and accepts pairing and output commands via MQTT or CLI.

## Why This Repo Is Worth Reviewing

PxB is a compact systems-integration project rather than a toy app. It combines:

- asynchronous Node.js service orchestration
- explicit MQTT API design and retained-state contracts
- hardware-facing driver lifecycle management with reconnect behavior
- configuration-driven runtime composition
- direct device adapters plus grouped light fan-out semantics
- a broad unit test surface over bridge, adapter, contract, and discovery logic

## What It Does

- Connects to Z-Wave and Zigbee USB radios; Zigbee is targeted at Sonoff EFR32MG21 coordinators (Dongle-LMG21 class) on the Ember adapter path.
- Controls **direct network/cloud light adapters** independently of any radio:
  - **Philips Hue** — issues commands via the Hue REST v2 API to a local bridge. Supports individual lights, rooms/zones (group target), or bridge-wide all-lights. Profile options: `color`, `ct` (color-temp), `dim`.
  - **WiZ** — sends UDP control packets directly to WiZ smart bulbs on the LAN. No cloud dependency; bulbs must be reachable by IP.
  - **LIFX** — issues commands via the LIFX Cloud API. Requires an API token; selector targets all lights on the account.
- Fans out light commands across mixed-vendor groups via `[light-zone:*]` sections.
- Publishes a **retained** heartbeat/lifecycle state for the bridge process itself on a fixed interval (default 10s).
- Publishes **retained on-change** node events and state for contact sensors, relays, etc.
- Accepts commands over MQTT (pairing, relay control, diagnostics) and an equivalent CLI.
- On discovery, emits an INI fragment ready to drop into the downstream consumer (PFx) with sensible defaults and clearly marked placeholders.

## Why PxB Exists

PFx was evolving toward direct Z-Wave, Zigbee, and light-adapter ownership. That coupled the radio stack and lighting lifecycle to the media controller lifecycle, made fault isolation hard, and required PFx to grow into device management territory. PxB takes that responsibility, lets PFx stay focused on media/effects, and gives every other Paradox component (PxO, Web UIs, PxT) a single stable MQTT contract for radio devices and lights.

## Project Status

**Implemented and test-backed.** PxB now has a working runtime, CLI, direct light and switch backends, Z-Wave and Zigbee bridge flows, backend-specific quick starts, and a green unit suite. The remaining work is mostly hardening, live hardware validation on specific coordinators/devices, and documentation polish. See [docs/PR_PZB_INITIAL.md](docs/PR_PZB_INITIAL.md) for the phased implementation record and outstanding follow-up items.

## Documentation

| Document | Purpose |
|----------|---------|
| [docs/TECHNICAL_SUMMARY.md](docs/TECHNICAL_SUMMARY.md) | Short reviewer-oriented summary of the architecture, implementation areas, and current status |
| [docs/SPEC.md](docs/SPEC.md) | Functional specification |
| [docs/MQTT_API.md](docs/MQTT_API.md) | MQTT topic/message contract |
| [docs/CONFIG_INI.md](docs/CONFIG_INI.md) | INI configuration reference |
| [docs/QUICK_START.md](docs/QUICK_START.md) | Install and first-run guide |
| [docs/Scaffold_Summary.md](docs/Scaffold_Summary.md) | Initial repo layout and what each file is for |
| [docs/PR_PZB_INITIAL.md](docs/PR_PZB_INITIAL.md) | Phased implementation plan with model-routing tags |

## Current Validation Snapshot

- ESLint 9 flat-config lint gate is wired and passing
- Unit suite is green across bridge, driver, contract, discovery, and adapter coverage
- Remaining uncertainty is concentrated in live hardware validation for specific coordinator/device combinations, not in missing local tooling or a broken test harness

## Paradox Family

PxB is one product in a set that composes a full escape-room stack:

- **PFx** — media/audio/lights/relays controller
- **PxO** — game orchestration engine
- **PxC** — configurable clock application framework
- **PxT** — player terminal kiosk
- **Pio** — GPIO-to-MQTT bridge
- **PxB** — Z-Wave / Zigbee / Thread bridge (this project)

All components share the same MQTT topic convention: `{baseTopic}/{commands|events|state|warnings}`.


## License

Dual-licensed:

- **AGPL-3.0** for open source use — see [LICENSE](LICENSE).
- **Commercial license required** for proprietary or revenue-generating use that does not comply with AGPL-3.0 — see [COMMERCIAL.md](COMMERCIAL.md).

Copyright © 2026 Mark Stevens.
