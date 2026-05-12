# PR Plan: PxB Fault Isolation Hardening

**Status:** Complete — all steps implemented and committed on `feature/fault-isolation`.
**Owner:** TBD
**Target branch:** `feature/fault-isolation` (to be created)
**Scope:** Make PxB resilient to runtime crashes in any single subsystem (radio driver, output adapter, future DMX writer) without taking the rest of the process down. Treated as a **prerequisite** to [PR_DMX_SUPPORT.md](PR_DMX_SUPPORT.md) Phase 1, but independently valuable and shippable on its own.

---

## 1. Why Now

Today PxB is **partially** crash-isolated:

- Adapter `init()` failures are caught in [src/index.js](../src/index.js) and replaced with `UnavailableOutputAdapter`.
- Per-command failures inside `executeCommand` are caught and surfaced as warnings.
- Radio drivers (Z-Wave, Zigbee) catch fatal driver errors and schedule reconnect.

But the global handlers in `src/index.js`:

```js
process.on('uncaughtException',  (err)    => safeShutdown('CRASH').finally(() => process.exit(1)));
process.on('unhandledRejection', (reason) => safeShutdown('CRASH').finally(() => process.exit(1)));
```

…tear down the entire process for **any** uncaught throw or rejected promise from **any** subsystem. That includes:

- A bug in a `setInterval` polling callback inside Hue/WiZ/LIFX/Shelly.
- An unhandled event listener throw from `zwave-js` or `zigbee-herdsman`.
- A future DMX 30 Hz writer loop that throws on a serial-port glitch.

For an escape-room production deployment, "one misbehaving fogger channel kills audio cues, lights, and contact sensors" is unacceptable. The DMX phases will add new always-on hot loops, so this is the right time to harden the host.

---

## 2. Goals

1. **One subsystem can crash without taking down the others.** Z-Wave can die and Zigbee/lights/switches/DMX keep running. A DMX writer can throw and Z-Wave/Zigbee/lights/switches keep running.
2. **Crashes are visible.** Every contained failure produces a warning on MQTT, a log entry with subsystem attribution, and a status change in `pxb/state`.
3. **Repeated crashes don't burn CPU.** If a subsystem keeps crashing, PxB stops trying and marks it failed until the next restart.
4. **Truly fatal conditions still exit.** Loss of the singleton lock, MQTT client construction failure, malformed config — these continue to exit non-zero and let systemd restart.
5. **No regressions** in current isolation behavior (init fallback, per-command catch, radio reconnect).

Non-goals:
- Process-level isolation via worker threads or child processes. (See §10, deferred.)
- Hot-reload of failed subsystems mid-process. (See §10, deferred.)

---

## 3. Approach Overview

Three independent improvements, each shippable on its own:

```
Step A — Subsystem registry + attributed crash handling
Step B — safeCall helper + uniform wrapping of adapter async surfaces
Step C — Per-subsystem crash budget + cooldown
```

A is the load-bearing change. B reduces the number of crashes that reach A in the first place. C prevents pathological tight loops.

After this PR lands, PxB has **in-process subsystem isolation**. The §10 stretch work covers true process isolation for cases this approach can't handle (e.g., a native add-on crash that doesn't surface as a JS exception).

---

## 4. Step A — Subsystem Registry + Attributed Crash Handling

**Goal:** When something throws, PxB can tell which subsystem it came from and decide whether to kill that subsystem or kill the process.

### Design

- New module: `src/bridge/subsystem-registry.js` exporting `SubsystemRegistry`.
- Every long-lived component registers itself at construction time:
  ```js
  registry.register({
      id: 'zwave-driver',
      kind: 'radio',
      criticality: 'optional',          // 'fatal' → process exit on crash; 'optional' → contain
      onCrash: async (err) => { /* mark failed, swap in fallback, etc. */ },
  });
  ```
- Registry maintains the active subsystem set and exposes:
  - `attribute(err)` → best-effort `{ subsystemId, criticality }` lookup using async-stored context (see below).
  - `crash(subsystemId, err)` → invoke `onCrash`, publish warning, update status.
  - `getSummary()` → contributes to `pxb/state` (`subsystems: { 'zwave-driver': 'ok', 'wiz-zone1': 'failed', ... }`).
- Attribution mechanism: use `AsyncLocalStorage` from `node:async_hooks` to tag every async surface (adapter timer callback, MQTT subscribe callback, driver event listener) with its owning subsystem id. The global `uncaughtException` / `unhandledRejection` handlers then read the current store to attribute the error.
- Global handlers in `src/index.js` updated to:
  1. Look up the attributed subsystem.
  2. If `criticality === 'fatal'` or no attribution exists → existing shutdown path (preserve today's behavior).
  3. Else → call `registry.crash(subsystemId, err)` and **return**. Process keeps running.
- Subsystem `onCrash` typical implementations:
  - **Radio driver:** mark driver `error`, stop reconnect loop, emit warning, leave node registry intact so already-known nodes still appear in heartbeat as `reachable: false`.
  - **Output adapter:** swap the live adapter for an `UnavailableOutputAdapter` keyed to the same topic, so MQTT consumers see structured `unsupported`-style warnings instead of silence.
  - **DMX writer (future):** stop the frame loop, close the serial port, mark the universe `error`, leave any DMX adapters in `degraded` state.

### Tasks
- [x] Add `src/bridge/subsystem-registry.js` with unit tests covering register/unregister/attribute/crash.
- [x] Add `src/bridge/async-context.js` thin wrapper around `AsyncLocalStorage` exposing `runInSubsystem(id, fn)` and `currentSubsystemId()`.
- [x] Decide on the public `kind` enum: `radio | output-adapter | dmx-bus | mqtt | http-api` (open `[ ]`).
- [x] Update `ZWaveDriver`, `ZigbeeDriver` constructors to register themselves as `kind: 'radio'`, `criticality: 'optional'`.
- [x] Update `HueAdapter`, `WizAdapter`, `LifxAdapter`, `ShellyAdapter`, `LightZoneAdapter` constructors similarly with `kind: 'output-adapter'`.
- [x] Update `MqttClient` registration as `kind: 'mqtt'`, `criticality: 'fatal'` (loss of MQTT is still a process-exit condition).
- [x] Rewrite the two `process.on` handlers in [src/index.js](../src/index.js) to use `registry.attribute()` + `registry.crash()`.
- [x] Extend `buildStatus()` in `src/index.js` to include a `subsystems` summary under `pxb/state`.
- [x] Update [docs/MQTT_API.md §3](MQTT_API.md) to document the new `subsystems` field in `pxb/state`.
- [x] Add unit tests:
  - Attributed throw inside a registered subsystem callback → `onCrash` invoked, process not exited.
  - Throw outside any registered subsystem → fallback to today's shutdown path.
  - `criticality: 'fatal'` subsystem throw → shutdown path.
- [x] Add an integration test (jest, no broker) that registers two fake subsystems, throws inside one's timer, and asserts the other keeps producing heartbeat.

### Risks
- `AsyncLocalStorage` propagation can be lost if a third-party library uses old-style callback chains that break the async context. Mitigation: also support **explicit attribution** by passing a `subsystemId` into the registry's helper functions. The registry should fall back to "best-effort attribution" rather than failing closed.
- Silent corruption: a contained crash might leave a partially-mutated in-memory state. Mitigation: in Step A, `onCrash` defaults to "stop the subsystem and route around it" rather than "restart in place." Hot restart is deferred to §10.

### Recommended AI model
- **Claude Sonnet — High** for the registry and async-context plumbing. This is the kind of code where subtle ordering bugs (handler installed before subsystems register, double-register on reconnect) are easy and unit tests do not always catch them.
- **Claude Sonnet — Medium** for adapter constructor updates and doc updates.

---

## 5. Step B — `safeCall` Helper + Uniform Wrapping

**Goal:** Prevent the majority of crashes from reaching the global handlers in the first place.

### Design

- Add `AdapterBase.safeCall(label, fn, options)`:
  ```js
  safeCall('hue-poll', async () => { ... }, { onError: 'warn' | 'silent' | 'rethrow' });
  ```
  Behavior:
  - Wraps `fn` in `try/catch` and `Promise.resolve(...).catch(...)`.
  - On error: logs with `${this.name}:${label}`, publishes a warning to `{topic}/warnings` unless `onError === 'silent'`, and returns `undefined`.
  - Re-enters the subsystem async context (Step A) so attribution works for any deeper throw that escapes.
- Audit all `setInterval` / `setTimeout` callbacks in adapters and wrap them.
- Audit all MQTT `subscribe(topic, cb)` callbacks owned by adapters and wrap them.
- Audit all `driver.on('event', listener)` handlers and wrap them (especially in `ZWaveEvents`, `ZigbeeEvents`).
- Add an ESLint rule (custom or via `no-restricted-syntax`) that flags raw `setInterval(` / `setTimeout(` / `on(.*function` patterns inside `src/lights/`, `src/switches/`, `src/radios/*/events.js`, and the future `src/dmx/`. Enforce via `npm run lint`.

### Tasks
- [x] Add `safeCall` to `AdapterBase` with unit tests.
- [x] Refactor each adapter and each event-wiring module to use it. Touch list:
  - [x] `src/lights/hue.js` poll timer + command subscribe + state-fetch error path
  - [x] `src/lights/wiz.js` poll timer + command subscribe + dispose unsubscribe
  - [x] `src/lights/lifx.js` poll timer + command subscribe
  - [x] `src/switches/shelly.js` poll timer + command subscribe + relay pulse setTimeout
  - [x] `src/lights/zone.js` command subscribe
  - [x] `src/radios/zwave/events.js` driver event listeners
  - [x] `src/radios/zigbee/events.js` driver event listeners
  - [x] `src/bridge/heartbeat.js` interval callback
  - [ ] `src/bridge/command-handler.js` MQTT subscribe callback — deferred: command-handler is synchronous and errors are already caught in the calling layer
  - [ ] `src/bridge/node-command-handler.js` MQTT subscribe callback — deferred: same as above
- [x] Add ESLint rule(s) preventing reintroduction of bare timers/listeners.
- [x] Add a Jest test that monkey-patches `global.setInterval` and asserts that, for a representative adapter, a thrown error inside the polled function does not propagate to the process.

### Recommended AI model
- **Claude Sonnet — Medium**
- Pure pattern-application across many small sites. The intellectual work was already done in Step A.

---

## 6. Step C — Per-Subsystem Crash Budget + Cooldown

**Goal:** Prevent a subsystem that's crashing on every tick from spamming the logs / MQTT and wasting CPU.

### Design

- In `SubsystemRegistry`, track `{ crashCount, firstCrashAt, lastCrashAt }` per subsystem.
- Policy (defaults, tunable later):
  - ≤ 3 crashes in 60 s → contain and continue.
  - 4–10 crashes in 60 s → contain, but mark subsystem `cooling-down` and pause its reconnect/restart attempts for 60 s.
  - More than 10 crashes in 60 s **and** repeated across cooldowns → mark `quarantined` for the rest of the process lifetime. PxB stays up; the quarantined subsystem stays disabled until the next restart.
- Quarantine actions:
  - Radio: stop driver, do not reschedule reconnect, leave node registry showing `reachable: false` for all of its nodes.
  - Output adapter: ensure `UnavailableOutputAdapter` is in place.
  - DMX writer: stop frame loop, leave serial port closed.
- Warnings: `SUBSYSTEM_CRASH` (severity `warn`), `SUBSYSTEM_QUARANTINED` (severity `error`). Document in [docs/MQTT_API.md §5](MQTT_API.md).
- `pxb/state.subsystems` reports `ok | crashed | cooling-down | quarantined | fatal`.

### Tasks
- [x] Implement crash-budget bookkeeping in `SubsystemRegistry`.
- [x] Implement cooldown timer and quarantine transitions.
- [x] Surface state transitions in `pxb/state` and as MQTT warnings.
- [x] Document the new state values and warning codes.
- [x] Tests:
  - 3 crashes inside the window → still `ok`-equivalent (contained).
  - 5 crashes inside the window → `cooling-down`, no further `onCrash` invocations until cooldown expires.
  - Crashes after cooldown → resume containment.
  - Pathological loop → `quarantined`, no further activity.

### Recommended AI model
- **Claude Sonnet — Medium**

---

## 7. Cross-Cutting Decisions

- [x] `criticality` enum: `fatal | optional` (Step A). Open question: do we want a third level `degraded-but-required` (e.g., one radio is required for the room to function, even though PxB can technically run without it)? Recommendation: **no** in this PR; that's a room-level policy, not a bridge-level one.
- [x] Naming: `subsystem` (used here) vs. `component`. Pick one and use it consistently in docs and code. Recommendation: **subsystem** — `component` is overloaded.
- [x] MQTT topic for subsystem-level warnings: reuse `pxb/warnings` with a `subsystem_id` field, do not add a new topic tree.
- [x] Heartbeat shape change: additive only. New `subsystems` field is optional for consumers; existing fields (`radios`, `nodes`, `inclusion`) are untouched.
- [x] Doc-first rule: update [docs/SPEC.md §15-16](SPEC.md), [docs/MQTT_API.md §3 and §5](MQTT_API.md) in the same commit as Step A.

---

## 8. Step-by-Step Order

Recommended commit sequence on `feature/fault-isolation`:

1. `Docs: PR_FAULT_ISOLATION.md` — this file (already happening).
2. `Docs: pxb/state subsystems field + warning codes` — `MQTT_API.md`, `SPEC.md` updates.
3. `Implement: SubsystemRegistry + async-context attribution (Step A)` — no behavior change for unregistered code paths.
4. `Implement: register radios and output adapters with the registry` — wires existing components in.
5. `Implement: replace global crash handlers with attributed dispatch` — flips the behavior. Tests must already cover this.
6. `Implement: AdapterBase.safeCall and uniform timer/listener wrapping (Step B)` — split into 2–3 commits if the diff gets large.
7. `Implement: crash budget + cooldown + quarantine (Step C)`.
8. `Test: 30-minute soak with synthetic adapter crashes` — manual test note in commit body, plus a long-running unit test gated behind `npm run test:soak`.

Each commit should leave PxB starting cleanly.

---

## 9. Acceptance Criteria

PxB has shipped fault isolation when **all** of the following hold:

1. Killing the Z-Wave stick mid-run leaves Zigbee, lights, switches, and MQTT fully operational. (Already true today, retained as a regression check.)
2. Injecting a synthetic uncaught throw into a Hue poll callback leaves all other adapters and radios fully operational; the offending adapter publishes a structured warning and is marked `failed` in `pxb/state.subsystems`.
3. The same synthetic throw repeated 20 times within 60 s drives the Hue adapter to `quarantined`, with no further crash spam, and the rest of PxB still healthy.
4. The MQTT client construction failure path still exits non-zero (no regression on truly fatal conditions).
5. `npm run test:unit` green; new tests cover registry, attribution, safe-call wrapping, and crash budget.
6. Heartbeat surfaces the new `subsystems` block and consumers (operator UI) can read it.

---

## 10. Out of Scope / Deferred

These are intentionally not part of this PR. Track them separately if the in-process approach proves insufficient.

- **Process isolation via `worker_threads` / child processes.** Required only if a native add-on (`zwave-js`, `zigbee-herdsman`) crashes the V8 isolate in a way JS handlers can't catch. Defer until evidence appears.
- **Hot restart of a failed subsystem mid-process.** Today's containment leaves a failed subsystem disabled until the next PxB restart. A "restart adapter X" bridge command is a clean follow-up but is not load-bearing for the DMX work.
- **Per-subsystem resource limits (CPU, memory).** Node makes this hard without process isolation. Out of scope.
- **Watchdog-style external health check on PxB.** systemd already restarts on full crash; subsystem-level health is exposed through `pxb/state.subsystems` and is monitored by the operator UI, not by a separate watchdog.

---

## 11. Phase Summary

| Step | Deliverable | Suggested model |
|---|---|---|
| A | Subsystem registry + attributed crash handling; global handlers no longer auto-exit on contained subsystems | Sonnet / High (registry + async context), Sonnet / Medium (wiring, docs) |
| B | `safeCall` helper + uniform timer/listener wrapping + ESLint guardrail | Sonnet / Medium |
| C | Crash budget, cooldown, quarantine | Sonnet / Medium |

Total: a focused single-PR effort. After this lands, the DMX plan ([PR_DMX_SUPPORT.md](PR_DMX_SUPPORT.md)) Phase 1 inherits the fault-isolation behavior automatically by registering the DMX universe writer as a subsystem of `kind: 'dmx-bus'`.
