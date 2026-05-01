# PxB Scaffold Summary

This document describes the initial repo layout created during the PxB scaffold. No runtime code exists yet — only structure, docs, and metadata.

## Files

| Path | Purpose |
|------|---------|
| `README.md` | User-facing overview with links into docs |
| `AI-INSTRUCTIONS.md` | Concise AI context (loaded automatically) |
| `AI-DETAILED-OVERVIEW.md` | Full architecture / lifecycle / module layout |
| `CLAUDE.md` | Pointer file for Claude workflows |
| `package.json` | Node deps (`zwave-js`, `mqtt`, `ini`), scripts, `pzb` CLI bin |
| `.gitignore` | Node / runtime artefact ignores |
| `docs/SPEC.md` | Functional specification |
| `docs/MQTT_API.md` | Topic + payload contract |
| `docs/CONFIG_INI.md` | INI reference with spell-box example |
| `docs/QUICK_START.md` | Install + first-run walkthrough |
| `docs/PR_PZB_INITIAL.md` | Phased implementation plan with model-routing tags |
| `docs/Scaffold_Summary.md` | This file |

## Planned Source Layout (Not Yet Created)

```
src/
  index.js
  config/{ini-loader.js, schema.js}
  mqtt/{client.js, contract.js}
  bridge/{bridge.js, heartbeat.js, node-registry.js, normalizer.js}
  radios/zwave/{driver.js, events.js, commands.js, inclusion.js}
  radios/zigbee/...            # phase 3
  cli/{index.js, commands/*.js}
  discovery/{ini-generator.js, discovered-store.js}
  util/{logger.js, ids.js}
test/
  unit/
  fixtures/
```

## Phases

See [PR_PZB_INITIAL.md](PR_PZB_INITIAL.md). Phases 0–2 cover Z-Wave phase 1 product. Phase 3 is Zigbee. Phase 4 is Thread. Phase 5 is hardening.

## What Is Deliberately Missing

- No `src/` yet — created alongside phase 1 implementation.
- No tests yet — scaffolded with `jest` but no test files.
- No systemd unit committed — template in QUICK_START only until we know final install prefix.
- No CI config — added when first real code lands.
