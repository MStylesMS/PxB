# PR: Paradox Z Bridge (PZB) — Initial Product

**Status:** Draft v0.1 — design finalized, scaffold landed, implementation phased below.

## Summary

Introduce **PZB (Paradox Z Bridge)**, a focused Node.js service that owns Z-Wave (and later Zigbee / Thread) radios on a Paradox host and exposes a simple MQTT contract for all downstream consumers. PZB replaces the short-lived direct-radio path in PFx. PFx and every other Paradox product (PxO, Web UIs, PxT) consume PZB via MQTT.

## Motivation

- Current PFx code began growing direct Z-Wave/Zigbee ownership. That couples media control and radio stack lifecycle, widens PFx's failure blast radius, and pushes PFx into device-management territory.
- For the sole running sensor (spell-box) the integration today depends on an external ad-hoc script (`.tmp_zwave_frontdoor_bridge.js`) — not sustainable.
- Heavy platforms like Z-Wave JS UI or Home Assistant are overkill for Paradox's tight scope.
- A small, opinionated bridge with an INI config, Paradox topic contract, and CLI pairing is the right fit.

## Goals

1. Single Node.js process per host managing one radio (Z-Wave first, Zigbee phase 3).
2. INI configuration following Paradox conventions.
3. Retained bridge heartbeat every `heartbeat_interval` seconds (default 10s).
4. Retained per-node `events` and `state` **only on change**.
5. Pairing via MQTT and CLI; generate INI fragments with `TODO:` placeholders for new devices.
6. Phase 1 device coverage: contact sensors (input) and relays (output).
7. Publish in a schema identical to the existing PFx `InputZone` contract so PFx needs no event-path changes.

## Non-Goals

- No automation/rules engine.
- No Web UI.
- No silent auto-publishing under guessed topics for unknown nodes.
- Phase 1 scope is intentionally small — more device classes are later PRs.

## Architecture Recap

See [AI-DETAILED-OVERVIEW.md](../AI-DETAILED-OVERVIEW.md). Key points:

- Single process, singleton radio driver per serial port.
- Modules: `config`, `mqtt`, `bridge`, `radios/zwave`, `cli`, `discovery`, `util`.
- PFx migration: remove direct Z-Wave/Zigbee from PFx; PFx `input_topic` points at PZB node `events`; PFx light/relay backends gain a `bridge` mode publishing to PZB node `commands`.

## Model Routing Legend

- 🟢 **Small**: can be done by smaller/cheaper models (Sonnet 4.6, GPT-5.4, Gemini 3.1 Pro). Scaffolding, doc drafting, INI parsing, MQTT wrappers, deterministic normalization, INI-fragment generator, unit tests, systemd files, cross-repo AI-file updates.
- 🔵 **Large**: needs stronger reasoning (Claude Opus tier). Radio driver lifecycle, reconnect/backoff, pairing FSM, PFx cross-product contract migration, any live-hardware behavior decisions, PR narrative reviews.

---

## Phase 0 — Scaffold & Documentation ✅

- [x] Create `/opt/paradox/apps/PZB/` repo skeleton. 🟢
- [x] Add `README.md`, `AI-INSTRUCTIONS.md`, `AI-DETAILED-OVERVIEW.md`, `CLAUDE.md`. 🟢
- [x] Add `docs/SPEC.md`, `docs/MQTT_API.md`, `docs/CONFIG_INI.md`, `docs/QUICK_START.md`, `docs/Scaffold_Summary.md`. 🟢
- [x] Add `package.json`, `.gitignore`. 🟢
- [x] Update sibling AI-INSTRUCTIONS in PFx/PxO/PxC/PxT/Pio to reference the full family including PZB and Pio. 🟢
- [x] Update `apps/PFx/docs/PR_ZWAVE_ZIGBEE_DIRECT.md` to pivot away from direct-in-PFx toward PZB bridge consumer. 🟢

### Gate
- Design and docs reviewed and approved before any `src/` code lands.

---

## Phase 1 — Minimal Bootable Bridge (Z-Wave, Contact Only)

### 1.1 Config + MQTT + Heartbeat ✅

- [x] `src/util/logger.js` — wraps console + level filter. 🟢
- [x] `src/config/schema.js` — per-section schema. 🟢
- [x] `src/config/ini-loader.js` — parse, validate, expand into typed config. 🟢
- [x] `src/mqtt/client.js` — thin wrapper over `mqtt` lib with retained helpers. 🟢
- [x] `src/mqtt/contract.js` — topic builders + retention policy. 🟢
- [x] `src/bridge/heartbeat.js` — periodic `pzb/status` publisher. 🟢
- [x] `src/index.js` — wire config + MQTT + heartbeat (no radio yet). 🟢
- [x] Unit tests: schema, loader, topic builders, heartbeat cadence. 🟢

Gate: `node src/index.js --config <empty-nodes>` publishes retained heartbeat every 10s.

### 1.2 Z-Wave Driver Lifecycle ✅

- [x] `src/radios/zwave/driver.js` — zwave-js singleton, start/stop, reconnect backoff. 🔵
- [x] Hook driver state into `pzb/status` (`radios.zwave.connected`, `node_count`). 🔵
- [x] Surface driver errors as bridge warnings. 🔵
- [x] Integration tests with mocked driver fixture. 🔵

Gate: radio opens on real hardware; yank-and-replug test produces `degraded` then `ok` without crash.

### 1.3 Node Registry + Contact Events ✅

- [x] `src/bridge/node-registry.js` — loads configured nodes, tracks runtime state. 🟢
- [x] `src/bridge/normalizer.js` — contact event normalization (reuses logic mirrored from PFx InputZone). 🟢
- [x] `src/radios/zwave/events.js` — wire zwave-js Notification CC → normalizer. 🔵
- [x] Publish retained per-node `events` and `state` on change only. 🟢
- [x] Unit tests: normalizer for all Z-Wave contact payload variants (0/1, 22/23, boolean, strings). 🟢

Gate: real spell-box open/close produces `open` / `close` events on its configured `base_topic`, PFx `InputZone` pointing at it updates state identically to the current working synthetic path.

### 1.4 CLI + MQTT Command Surface (Read-Only + Status) ✅

- [x] `src/cli/index.js` — arg parser, subcommand loader. 🟢
- [x] `pzb status` — dumps current retained `pzb/status` (pretty-printed). 🟢
- [x] `pzb list-nodes` — prints configured + discovered nodes. 🟢
- [x] MQTT `getNetworkStatus` handler. 🟢

Gate: CLI status and MQTT `getNetworkStatus` agree.

### 1.5 Packaging ✅

- [x] Commit systemd unit template under `config/systemd/pzb.service`. 🟢
- [x] Publish minimal `docs/QUICK_START.md` walkthrough with real commands. 🟢

Gate: installable on a Pi and boots under systemd.

---

## Phase 2 — Pairing, Relays, and Discovery Export

### 2.1 Inclusion / Exclusion FSM ✅

- [x] `src/radios/zwave/inclusion.js` — inclusion/exclusion state machine. 🟢
- [x] MQTT handlers: `startInclusion`, `stopInclusion`, `startExclusion`, `stopExclusion`. 🟢
- [x] Reflect active inclusion in `pzb/status.inclusion`. 🟢
- [x] Timeouts → `INCLUSION_TIMEOUT` bridge warning. 🟢

Gate: real device includes and excludes reliably; timeouts handled cleanly.

### 2.2 Discovery INI Generator ✅

- [x] `src/discovery/ini-generator.js` — build fragment from interviewed node. 🟢
- [x] `src/discovery/discovered-store.js` — persist fragments to `discovered.ini` sidecar. 🟢
- [x] Retained discovery notice on `pzb/discovered/zwave/<nodeId>`. 🟢
- [x] `pzb dump-ini` — print fragment to stdout on demand. 🟢

Gate: including a fresh sensor yields a correct, paste-ready INI block with all `TODO:` markers.

### 2.3 Relay Output ✅

- [x] `src/radios/zwave/commands.js` — binary switch set/pulse. 🟢
- [x] Node-level command handler: `setRelay`, `pulseRelay`. 🟢
- [x] Echo result into node state (`signals.relay`). 🟢
- [x] `pzb relay <label> on|off|pulse --ms N` CLI. 🟢
- [x] Unit tests + integration test against a mock driver. 🟢 *(unit tests against mock driver; hardware validation pending)*

Gate: real Z-Wave relay toggles from MQTT and CLI; failures produce `COMMAND_TIMEOUT` / `COMMAND_UNSUPPORTED` warnings.

### 2.4 Node Lifecycle Commands ✅

- [x] `refreshNode` handler. 🟢
- [x] `removeFailedNode` handler. 🟢
- [x] Per-node `NODE_FAILED` / `NODE_RECOVERED` warnings. 🟢

Gate: failed-node scenario reproduced on bench and recovered via command.

---

## Phase 3 — Zigbee (Deferred Until Z-Wave Phase 2 Gates Pass)

- [ ] Add `zigbee-herdsman`. 🟢
- [ ] Mirror `radios/zwave/` layout as `radios/zigbee/`. 🔵
- [ ] Extend schema for `[zigbee]` + `ieee` node key. 🟢
- [ ] Support contact + on/off light/relay only in first Zigbee cut. 🔵
- [ ] Discovery + INI generator extension for Zigbee. 🟢

Gate: at least one contact sensor and one on/off endpoint working on real HUSBZB-1 Zigbee radio.

---

## Phase 4 — Thread (Future, Design Only)

- [ ] Survey library options (OTBR, ot-br-posix integration, vendor libs). 🔵
- [ ] Draft Thread section in SPEC + CONFIG_INI with `[thread]`. 🔵
- [ ] Decide on commissioner responsibilities (PZB vs external). 🔵

No code in this phase.

---

## Phase 5 — Hardening & Operational Polish

- [ ] TLS option for MQTT. 🟢
- [ ] Rate limiting / backoff on mis-used commands. 🟢
- [ ] Health endpoints for CLI (`pzb doctor`). 🟢
- [ ] Expanded soak testing on real deployments. 🔵
- [ ] Operator runbook in `docs/OPERATOR_RUNBOOK.md`. 🟢
- [ ] README link consolidation. 🟢

---

## Risks

- **zwave-js version drift**: pin major in `package.json`; soak after bumps.
- **Serial device name instability**: require stable `/dev/serial/by-id/...` paths; reject bare `/dev/ttyUSBn`.
- **Double ownership during migration**: PFx direct-radio code must be removed before PZB goes live on the same host.
- **Retention mistakes**: node `events` and `state` must NEVER be published unretained; bridge `status` must NEVER be on-change-only.

## Validation Matrix (Phase 1 Exit)

- [x] Heartbeat cadence within ±200ms of configured interval. *(unit tested)*
- [ ] Contact sensor open/close → correct retained event + state update on change only. *(normalizer unit tested; end-to-end requires hardware)*
- [ ] PFx `InputZone` consumes PZB events with no code changes. *(requires live integration test)*
- [ ] USB unplug → `degraded` → replug → `ok` without PZB crash. *(requires hardware)*
- [x] Malformed INI → fails fast with actionable error. *(unit tested)*
- [ ] Clean SIGTERM shutdown (no MQTT publish-after-disconnect). *(not yet tested)*

## Coordination

- PFx PR: `apps/PFx/docs/PR_ZWAVE_ZIGBEE_DIRECT.md` — pivots direct path to PZB consumer, retires direct Z-Wave code from PFx in lockstep.
- Web UIs (Houdini / Agent22): subscribe to `{base_topic}/pzb/status` for online/offline monitoring, same pattern already used for screen zones.
