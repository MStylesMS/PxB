# PxB Repo Summary

This document summarizes the current PxB repository layout. The project is no longer a scaffold-only repo: the runtime, CLI, unit tests, and operational docs are all present.

## Files

| Path | Purpose |
|------|---------|
| `README.md` | User-facing overview with links into docs |
| `AI-INSTRUCTIONS.md` | Concise AI context (loaded automatically) |
| `AI-DETAILED-OVERVIEW.md` | Full architecture / lifecycle / module layout |
| `CLAUDE.md` | Pointer file for Claude workflows |
| `package.json` | Node deps, npm scripts, and the `pxb` CLI bin |
| `.gitignore` | Node / runtime artefact ignores |
| `docs/SPEC.md` | Functional specification |
| `docs/MQTT_API.md` | Topic + payload contract |
| `docs/CONFIG_INI.md` | INI reference with spell-box example |
| `docs/QUICK_START.md` | Install + first-run walkthrough |
| `docs/PR_PZB_INITIAL.md` | Phased implementation plan with model-routing tags |
| `docs/Scaffold_Summary.md` | This file |

## Current Source Layout

```
src/
  index.js
  adapter-base.js
  adapters/
  bridge/
  cli/
  config/
  discovery/
  lights/
  mqtt/
  radios/
    zwave/
    zigbee/
  switches/
  util/
test/
  unit/
```

## What Exists Today

- Runtime bridge entry point, heartbeat, MQTT contract, discovery store, and node registry
- Z-Wave and Zigbee driver/event/inclusion flows
- Direct output/control adapters for Hue, WiZ, LIFX, Shelly, and generic light zones
- Unit tests covering config loading, drivers, bridge commands, discovery, normalizers, and device adapters
- Backend-specific quick starts and migration-gap notes for the PFx-to-PxB transition

## Follow-up Work

See [PR_PZB_INITIAL.md](PR_PZB_INITIAL.md). The remaining items are concentrated in hardening, live hardware validation, and future Thread work.

## Notes

- The repo still includes planning and investigation documents from the scaffold phase because they record design decisions and hardware findings.
- Some live hardware validation remains device-dependent even though the unit suite is broad.
