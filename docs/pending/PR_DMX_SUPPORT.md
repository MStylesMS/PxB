# PR Plan: DMX Output Support in PxB

**Status:** Draft v0.1 — planning only, no implementation yet.
**Owner:** TBD
**Target branch:** `feature/dmx-support` (to be created)
**Scope:** Add DMX512 output as a first-class PxB capability, starting with a single FTDI USB-DMX cable on Pi5, and ending with a clean extension path to additional DMX interfaces, fixture profiles, effects (foggers, strobes), and motion devices.

> Implementation is intentionally split into **independent phases**. Each phase ships a fully working PxB and adds a self-contained feature. Phases after Phase 2 can be reordered or run in parallel.

> **Prerequisite:** [PR_FAULT_ISOLATION.md](PR_FAULT_ISOLATION.md) should land before Phase 1 of this plan. The DMX writer adds an always-on 30 Hz timer loop, which is exactly the kind of code that benefits from subsystem-level crash containment.

---

## 1. Why DMX in PxB

PxB already owns hardware I/O for Paradox: Z-Wave, Zigbee, Hue, WiZ, LIFX, Shelly. Lighting and FX hardware over DMX is the natural next domain. Putting it in PxB:

- Keeps a single MQTT contract (`{base_topic}/{commands|state|events|warnings}`) for all hardware.
- Reuses the existing `[light:*]` / `[light-zone:*]` command vocabulary documented in [MQTT_API.md §9a](MQTT_API.md).
- Avoids adding a serial-port owner to PFx, PxO, or rooms — PxB stays the **single writer** to hardware.
- Lets PxO drive DMX fixtures through the same `setColorScene` / `setBrightness` commands it already uses for Hue/WiZ/LIFX.

DMX is **not** added as a new "radio" alongside Z-Wave/Zigbee. The radio model (inclusion, per-node IDs, discovery notices) does not fit DMX. DMX is a continuously transmitted 512-channel universe, so it belongs in the **output adapter** layer next to `src/lights/` and `src/switches/`.

---

## 2. Starting Hardware

Confirmed plugged into the development Pi5:

| Field | Value |
|---|---|
| Stable path | `/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_B002JE1K-if00-port0` |
| Node path | `/dev/ttyUSB0` |
| Kernel driver | `ftdi_sio` |
| USB IDs | `0403:6001` |
| Manufacturer / product | `FTDI` / `FT232R USB UART` |
| Serial | `B002JE1K` |
| FTDI latency timer | `16` (will be retuned in Phase 1) |

**Classification:** Generic FTDI-based USB→DMX adapter (Open DMX / DMXKing ultraDMX Micro class). The host generates DMX timing; the cable is a "dumb" RS-485 transmitter. Good for development and small rooms, weaker than a buffered Enttec DMX USB Pro under host load. The plan keeps this distinction first-class so we can add a Pro-class backend later without rewriting the adapter.

---

## 3. Phase Map

```
Phase 0 — Hardware validation (out-of-tree)
Phase 1 — DMX universe writer (Open DMX / FTDI bit-bang or break+frame)
Phase 2 — Light backend: backend = dmx (basic on/off/brightness/color/scene)
Phase 3 — Fixture profile library (RGB, RGBW, RGBAWUV, dimmer-only, mover-basic)
Phase 4 — Second DMX interface backend (Enttec DMX USB Pro class)
Phase 5 — Effects domain: foggers, strobes, hazers, channel pulses
Phase 6 — Motion / movers (pan/tilt + presets)
Phase 7 — Universe sharing, scenes, transitions, sACN/Art-Net bridge (stretch)
```

Phases 0–2 are **strictly sequential**. Phases 3–7 are independent and can be picked off in any order once Phase 2 lands.

---

## 4. Phase 0 — Hardware Validation (out-of-tree probe)

**Goal:** Prove the cable can actually drive a DMX fixture from this Pi before we touch PxB.

This phase produces **no PR**. The validation script lives in `tools/dmx-probe/` (committed, excluded from production builds).

### Validation Fixture

**6-Channel RGBW LED PAR** (generic Chinese LED par, confirmed on-hand):

Set the fixture to DMX address **1** and **6CH mode** using its onboard display (press Menu → set `A` to `001`, set mode to `DMX 6CH`).

Channel layout:

| Channel | Range | Function |
|---------|-------|----------|
| CH1 | 0–8 | No effect (master off) |
| CH1 | 9–134 | Master dimmer: RGBW dark → bright |
| CH1 | 135–239 | Strobe: slow → fast |
| CH1 | 240–255 | Activate CH2–CH5 independent control |
| CH2 | 0 | Red off |
| CH2 | 1–255 | Red dark → bright |
| CH3 | 0 | Green off |
| CH3 | 1–255 | Green dark → bright |
| CH4 | 0 | Blue off |
| CH4 | 1–255 | Blue dark → bright |
| CH5 | 0 | White off |
| CH5 | 1–255 | White dark → bright |
| CH6 | 0–2 | No effect |
| CH6 | 3–223 | Various auto-programs |
| CH6 | 224–255 | Sound-reactive programs (ignore for validation) |

**For Phase 0 testing:** Set CH1=240 (independent RGBW mode), then exercise CH2–CH5 individually. CH6=0 throughout validation (disables auto-programs).

### Tasks
- [x] Confirm `paradox` user is in the `dialout` group (`groups paradox`), or add a udev rule for `0403:6001` that grants access without sudo.
- [x] Verify no other process owns the port (`lsof /dev/ttyUSB0`).
- [x] Write validation script `tools/dmx-probe/probe.js` using `serialport` that:
  - opens `/dev/ttyUSB0` at 250000 baud, 8N2,
  - generates BREAK via baud-rate switch (76800 baud + 0x00 byte = ~104 µs LOW; reliable on ftdi_sio; `port.set({brk})` was tried first and rejected — produced only occasional valid frames on this Pi5/ftdi_sio combination),
  - repeats at ~9 Hz (baud-switch open/close overhead limits throughput),
  - runs the sequence: CH1=240, CH2–CH5 cycle R→G→B→W→RGBW→off (3 s each),
  - runs for ≥60 s then exits cleanly.
- [x] Connect fixture at DMX address 1 in 6CH mode and visually confirm each color step fires correctly.
- [x] Run under load: `stress -c 4` during the RGBW soak. No flicker observed.
- [x] Record the FTDI `latency_timer` value used: **4 ms** (set manually; udev rule committed to `config/udev/99-ftdi-dmx.rules` — ATTR path needs correction before it fires automatically).

### Fixture setup reference (onboard display)
```
Press Menu → scroll to "A" → set 001 → ENTER    (DMX start address = 1)
Press Menu → scroll to run mode → set "1"        (6CH DMX mode; label may read "DMX (6CH)")
```

### Exit criteria
- Each of R, G, B, W channels responds at the correct DMX address with no cross-talk to adjacent channels.
- Output is stable for ≥60 s under load with no visible flicker.
- If the fixture flickers badly even at `latency_timer=1`, **stop and document** before continuing. This is likely a timing problem with the cable under Pi5 load, and Phase 4 (Enttec Pro) becomes the path forward for production.

### Results (fill in after running)
| Field | Value |
|---|---|
| Date | 2026-05-12 |
| Fixture response | All 6 steps correct: blackout → dim → R → G → B → W → RGBW → off |
| `latency_timer` used | 4 ms |
| Avg FPS | 8.8 (baud-switch overhead; adequate for DMX control) |
| Load test result | `stress -c 4` during RGBW soak — no flicker |
| BREAK method | baud-rate switch (76800 baud + 0x00); `port.set({brk})` rejected — unreliable on ftdi_sio/Pi5 |
| Blocker / notes | None. Phase 0 exit criteria met. Proceed to Phase 1. |

### Recommended AI model
- **Claude Sonnet — Medium**
- Local hardware poking + small Node script. No architectural decisions, no doc churn.

---

## 5. Phase 1 — DMX Universe Writer

**Goal:** A reusable, transport-pluggable DMX universe writer inside PxB that owns the serial port and emits frames continuously. **No MQTT surface yet** — this phase is internal plumbing plus unit tests.

### Design

- New module: `src/dmx/universe.js` exporting `DmxUniverse`.
- Owns one 513-byte buffer (`[0]` = start code `0x00`, `[1..512]` = slots).
- Public API:
  - `setChannel(channel, value)` — 1-based, clamped 0–255, marks frame dirty.
  - `setChannels(map)` — `{channel: value}` batch.
  - `blackout()` — zero all slots.
  - `getStatus()` — `{ connected, port, interface, refresh_hz, last_frame_ts, frame_count, last_error }`.
  - `start()` / `dispose()` — lifecycle, same shape as `ZWaveDriver` / `ZigbeeDriver`.
  - `EventEmitter`: `state-changed`, `warning`, `connected`, `disconnected`.
- Interface abstraction: `src/dmx/interfaces/`:
  - `opendmx.js` — direct FTDI BREAK/MAB + frame via `serialport`. Phase 1 target.
  - `enttec-pro.js` — stub only (interface present, factory throws "not implemented"). Filled in Phase 4.
- Configurable refresh: default 30 Hz, allow 24–44 Hz.
- Universe writer survives serial errors with exponential backoff identical to the radio drivers (reuse pattern from `src/radios/zwave/driver.js`).

### Config additions

New top-level section in INI (one universe per process for Phase 1; multi-universe is Phase 7):

```ini
[dmx]
enabled        = true
interface      = opendmx                  ; opendmx | enttec-pro (Phase 4)
port           = /dev/serial/by-id/usb-FTDI_FT232R_USB_UART_B002JE1K-if00-port0
refresh_hz     = 30                       ; 24..44
universe_size  = 512                      ; 24..512, advisory
ftdi_latency_ms = 4                       ; opendmx only; ignored otherwise
```

Schema work in `src/config/schema.js` + validation in `src/config/ini-loader.js`. Reject `interface = enttec-pro` with a clear "phase 4" error until that backend lands.

### Tasks
- [x] Add `serialport` dependency to `package.json` (pin a current major; verify Pi5 aarch64 prebuilt available).
- [x] Update `docs/SPEC.md` §3 (Supported Device Classes) to include DMX output.
- [x] Update `docs/SPEC.md` §7 (Configuration Model) to list the `[dmx]` section.
- [x] Add `docs/CONFIG_INI.md` `[dmx]` reference with key table.
- [x] Add `src/dmx/universe.js`, `src/dmx/interfaces/opendmx.js`, `src/dmx/interfaces/index.js` factory.
- [x] Wire universe construction into `src/index.js` after MQTT connect, before light adapters.
- [x] Surface universe status in `pxb/state.radios` (rename to `radios_and_buses` would be a bigger doc change — for now, add `dmx` as a sibling key under `radios` and note it in MQTT_API.md §3).
- [x] Unit tests in `test/unit/dmx/`:
  - `universe.test.js` — channel set/clamp/dirty/blackout, status shape.
  - `opendmx.test.js` — frame composition (start code, BREAK timing call, slot count), with `serialport` mocked.
  - `ini-loader.test.js` extension — schema accepts/rejects `[dmx]` keys.
- [x] Manual smoke test on the Pi5 using the Phase 0 fixture: start PxB with `[dmx]` configured, no `[light:*]` sections, confirm continuous frame transmission via `top`/`strace -p`.

### Out of scope for Phase 1
- MQTT-addressable lights — Phase 2.
- Fixture profiles — Phase 3.
- Enttec Pro — Phase 4.

### Exit criteria
- PxB starts with `[dmx]` configured, opens the port, and emits frames at the configured refresh rate.
- Unit suite green (`npm run test:unit`).
- Heartbeat shows the DMX status block.
- Phase 0 fixture still responds when channel value is poked via a test hook (e.g., a temporary `pxb` CLI command behind `--debug-dmx`, removed before merge if not generalized).

### Recommended AI model
- **Claude Sonnet — High** for the universe + opendmx interface (timing-sensitive, easy to get subtly wrong).
- **Claude Sonnet — Medium** for INI schema, tests, and docs.
- Avoid Haiku/Mini tiers for the writer itself; the BREAK/MAB + frame-rate scheduling is the kind of code where small mistakes pass tests and fail on real fixtures.

---

## 6. Phase 2 — Light Backend `backend = dmx`

**Goal:** First MQTT-controllable DMX light. End state: an operator can drop a `[light:*]` section with `backend = dmx` and drive a single fixture with the existing PxB light command vocabulary.

### Design

- New adapter: `src/lights/dmx.js` extending `AdapterBase`.
- Receives a reference to the shared `DmxUniverse` instance from `src/index.js`.
- Per-fixture config:

```ini
[light:stage-rgb]
backend     = dmx
topic       = paradox/houdini/lights/stage-rgb
fixture     = rgb                        ; built-in profile, see Phase 3
address     = 1                          ; DMX start address (1..512)
brightness  = 100
scene_map   = { ... }                    ; optional, reuses Hue/WiZ schema
```

- For Phase 2, ship exactly **two** built-in fixture profiles inline (the full library is Phase 3):
  - `dimmer` — 1 channel: intensity.
  - `rgb` — 3 channels: R, G, B.
- Supported commands (subset of [MQTT_API.md §9a](MQTT_API.md)):
  - `on`, `off`, `allOn`, `allOff`
  - `setBrightness`
  - `setColor` (`rgb` profile only; warn on `dimmer`)
  - `setColorScene` / `scene`
  - `getState`, `getStatus`
- Unsupported in Phase 2 (must publish a structured warning, not silently drop): `fade`, `setColorTemp`. Document explicitly in `docs/COMMAND_COMPATIBILITY` style — add a short compatibility note to `MQTT_API.md §9a`.
- State publishing: retained, on every command, same shape as `HueAdapter` (`{ on, brightness, color, scene, ... }`).
- `LightZoneAdapter` should already work with DMX members without changes; verify with a mixed zone (one DMX + one WiZ).

### Tasks
- [x] Add `'dmx'` to `VALID_LIGHT_BACKENDS` in `src/config/schema.js`.
- [x] Extend `SCHEMA.light` with `fixture`, `address`, and validate `address + channel_count - 1 <= 512`.
- [x] Add `src/lights/dmx.js` implementing `AdapterBase`.
- [x] Update `src/index.js` to inject the shared `DmxUniverse` into `DmxAdapter` and to refuse to start DMX lights when `[dmx]` is absent or disabled (publish init warning, fall through to `UnavailableOutputAdapter`).
- [x] Update `docs/MQTT_API.md §9a` with a small "DMX backend caveats" subsection.
- [x] Update `docs/CONFIG_INI.md` `[light:<label>]` table to describe `fixture` + `address`.
- [x] Add `docs/QUICK_START_DMX.md` following the pattern of `QUICK_START_WIZ.md`.
- [x] Unit tests in `test/unit/lights/dmx.test.js`:
  - Command dispatch table.
  - Channel math for `dimmer` and `rgb` against a mocked universe.
  - `setColorScene` mapped through the built-in scene map.
  - Warning published for `setColorTemp` and `fade`.
- [x] Manual MQTT test on Pi5: drive the Phase 0 fixture from `mosquitto_pub`, then drive it from PxO via an existing room config.

### Exit criteria
- Operator can stand up a DMX RGB fixture using config alone.
- Mixed `[light-zone:*]` works with at least one DMX + one non-DMX member.
- All existing PxB unit tests still pass; new tests cover the dispatch table and channel math.

### Recommended AI model
- **Claude Sonnet — Medium**
- This phase is mostly pattern-matching against `src/lights/wiz.js` and `src/lights/hue.js`. The unknowns (timing, BREAK) were paid for in Phase 1.

---

## 7. Phase 3 — Fixture Profile Library (independent)

**Goal:** Make new fixtures a config-only operation for room authors, not a code change.

### Design
- Profiles live in `src/dmx/profiles/` as plain JS objects (or JSON loaded at startup). Each profile declares:
  - `name`
  - `channels`: ordered array of named slots (`["dimmer","red","green","blue","white"]`)
  - `capabilities`: subset of `["dimmer","color","colorTemp","strobe","pan","tilt","gobo","mode"]`
  - Optional `defaults`: channel values to apply on `on` (e.g., mode channel set to a sane value).
- Adapter routes light commands through the profile's capabilities, warns on anything the profile cannot satisfy.
- Allow `fixture = custom` plus `channels = dimmer:1,red:2,green:3,blue:4,white:5` in the INI for one-off fixtures without a code change.

### Profiles to ship in Phase 3
- [x] `dimmer` (1 ch) — already shipped Phase 2; moved into the library.
- [x] `rgb` (3 ch) — already shipped Phase 2; moved into the library.
- [x] `rgbw` (4 ch)
- [x] `rgba` (4 ch)
- [x] `rgbaw` (5 ch)
- [x] `rgbawuv` (6 ch)
- [x] `par-7ch` (common cheap LED par: dimmer, R, G, B, strobe, mode, speed)
- [x] `mover-basic` (pan, tilt, dimmer) — minimal, no presets; Phase 6 expands this.

### Tasks
- [x] Define profile schema + validator (`src/dmx/profiles/schema.js`).
- [x] Implement profile loader and `fixture = custom` channel-map parser.
- [x] Unit tests per profile: channel layout, capability gating, scene mapping.
- [x] Doc: `docs/DMX_FIXTURES.md` cataloging built-in profiles, plus a recipe for custom fixtures.
- [x] Update `docs/QUICK_START_DMX.md` with a "choose your fixture" section.

### Exit criteria
- Adding a new common LED par or RGBAWUV light is config-only.
- Custom channel maps work end-to-end without code changes.

### Recommended AI model
- **Claude Sonnet — Medium**
- Pattern work + careful test matrices. No timing concerns.

---

## 8. Phase 4 — Enttec DMX USB Pro Class Backend (independent)

**Status: Code complete — unit-tested — hardware validation pending.**

> The code tasks below are done. The hardware checklist items below are **future work** and do not block the Phase 4 or Phase 5 code from landing.

**Goal:** Production-grade DMX interface support without touching the adapter or fixture layers.

### Design
- Implement `src/dmx/interfaces/enttec-pro.js` against the Enttec DMX USB Pro Open Protocol (label-framed, including label `6` for DMX output).
- No change to `DmxUniverse`, `DmxAdapter`, or fixture profiles.

### Tasks
- [x] Implement `enttec-pro.js` frame builder + serial write (label-6 envelope, 57600 baud 8N1, persistent port).
- [x] Unit tests for label framing, port lifecycle, and path-change reconnect.
- [x] Update `src/config/schema.js`: add `enttec-pro` to `IMPLEMENTED_DMX_INTERFACES`.
- [x] Remove Phase-4 guard from `src/config/ini-loader.js`.
- [ ] **HARDWARE:** Validate against an actual Enttec DMX USB Pro or DMXKing ultraDMX2 Pro — see checklist below.
- [ ] **HARDWARE:** Update `docs/SPEC.md` §19 "Supported Devices" with the validated model + firmware version.

### Exit criteria
- Swapping `interface = opendmx` for `interface = enttec-pro` on the same fixture works with no other config change.

### ⚠ Hardware Validation Checklist (requires physical Enttec Pro device)

The code is written to spec but has **not been tested against a real device**. When you have an Enttec DMX USB Pro or DMXKing ultraDMX2 Pro, work through this list:

- [ ] Plug device in. Confirm USB path:  
      `ls /dev/serial/by-id/`
- [ ] Confirm FTDI USB ID:  
      `lsusb | grep -i ftdi`  
      (expect `0403:6001` or `0403:FA63`)
- [ ] Update `config/dmx-manual-test.ini`:  
      `interface = enttec-pro` and correct `port = /dev/...` path.
- [ ] Start PxB:  
      `node src/index.js --config config/dmx-manual-test.ini`  
      Confirm no startup errors.
- [ ] Send `on` command. Confirm fixture lights up at expected level.
- [ ] Run the same colour and brightness tests from the Phase 2 manual test.
- [ ] Test at default `refresh_hz = 30` and at 44 Hz; confirm no flicker or dropped frames.
- [ ] If the fixture does not respond:
  - Confirm baud rate is 57600 (not 250000 — that is the OpenDmx line rate).
  - Try `EnttecProInterface.interFrameDelayMs = 2` in the source (documented TODO in `enttec-pro.js`).
  - Capture serial output with `stty -F /dev/ttyUSB0 raw; hexdump -C /dev/ttyUSB0` and compare against the Enttec USB Pro Communications Protocol v1.44 §5.
- [ ] Run 30-minute continuous-frame stability test under load:  
      `stress -c 4` (in a second terminal while PxB is running)  
      Confirm no fixture flicker.
- [ ] Mark `src/dmx/interfaces/enttec-pro.js` `TODO(hardware)` comment as validated.
- [ ] Update `docs/SPEC.md` §19 "Supported Devices" with: validated model, firmware version seen in `lsusb`, date tested, Pi model tested on.
- [ ] Commit with message:  
      `Test: Phase 4 hardware validation — Enttec USB Pro on <device> (<date>)`

### Recommended AI model
- **Claude Sonnet — High** for any framing fix if the fixture misbehaves (protocol mistakes are silent until a real fixture talks back).
- **Claude Sonnet — Low** for the docs-only update after validation passes.

---

## 9. Phase 5 — Effects Domain: Foggers, Strobes, Hazers (independent)

**Status: Code complete — hardware validation pending.**

**Goal:** First-class commands for short-duration effect devices that don't fit the "light" mental model.

### Design
- New adapter family: `src/effects/dmx.js` extending `AdapterBase`.
- New config section: `[effect:<label>]` with `backend = dmx`, `fixture = fogger-1ch | fogger-2ch | strobe-2ch | hazer-2ch`, `address`, `topic`.
- New command vocabulary (additive to existing — does not alter `[light:*]` commands):
  - `{ "command": "burst", "duration_ms": 1500 }`
  - `{ "command": "pulse", "duration_ms": 250, "intensity": 80 }`
  - `{ "command": "stop" }`
  - `{ "command": "setIntensity", "intensity": 60 }`
- Adapter manages its own timers and guarantees `stop` on dispose (no stuck foggers).
- **Safety:** config-level `max_run_ms` cap per effect; the adapter refuses any command that would exceed it and publishes a warning. Default: 4000 ms.

### Tasks
- [x] Add `[effect:*]` section schema + validation (`src/config/schema.js`, `src/config/ini-loader.js`).
- [x] Implement `DmxEffectAdapter` with timer discipline (`src/effects/dmx.js`).
- [x] Wire effect adapters in `src/index.js` (init loop, graceful shutdown).
- [x] Add effect fixture profiles: `fogger-1ch`, `fogger-2ch`, `strobe-2ch`, `hazer-2ch` in `src/dmx/profiles/`.
- [x] Add `'effect'` capability to profile schema validator.
- [x] Document the new command set in `docs/MQTT_API.md` (§9b).
- [x] Update `docs/SPEC.md` §3 with the `effect` device class.
- [x] Add `docs/QUICK_START_DMX_EFFECTS.md`.
- [x] Update `docs/DMX_FIXTURES.md` with the 4 new effect profiles.
- [x] Update `docs/CONFIG_INI.md` with `[effect:<label>]` section reference.
- [x] Unit tests: timer-based behavior with jest fake timers, max_run_ms enforcement, dispose stops output (`test/unit/effects/dmx-effect-adapter.test.js`).

### ⚠ Hardware Validation Checklist (requires physical effect device)

The code is written to spec but has **not been tested against a real device**. When you have a fogger, strobe, or hazer patched to a DMX universe, work through this list:

**Fogger (`fogger-1ch` or `fogger-2ch`):**
- [ ] Patch fogger to known DMX address. Update INI `[effect:fogger]` accordingly.
- [ ] Start PxB; confirm adapter shows `ready` in `{effect.topic}/state`.
- [ ] Publish `{ "command": "burst", "duration_ms": 2000 }`. Confirm fog fires and stops after 2 s.
- [ ] Confirm `burst-ended` event appears on `{effect.topic}/events`.
- [ ] Publish `{ "command": "burst", "duration_ms": 99999 }`. Confirm `EFFECT_DURATION_CAPPED` warning; no fog.
- [ ] Publish `{ "command": "stop" }` mid-burst. Confirm fog stops immediately.
- [ ] For `fogger-2ch`: vary `fan_speed` in INI; confirm CH2 changes air projection.

**Strobe (`strobe-2ch`):**
- [ ] Publish `{ "command": "burst", "duration_ms": 1000 }`. Confirm strobe fires for 1 s at configured `strobe_rate`.
- [ ] Vary `strobe_rate` in INI; confirm CH1 speed difference on device.
- [ ] Confirm `stopped` event appears when `stop` is sent mid-burst.

**Hazer (`hazer-2ch`):**
- [ ] Publish `{ "command": "setIntensity", "intensity": 30 }`. Confirm continuous haze output.
- [ ] Publish `{ "command": "stop" }`. Confirm haze stops.
- [ ] Confirm CH2 fan dispersion tracks `fan_speed` config.

**Safety:**
- [ ] Kill PxB mid-burst (`kill -9 <pid>`). Confirm all channels zero after reconnect.
- [ ] Confirm light fixtures on the same universe are unaffected by effect commands.

When hardware tests pass, commit:  
`Test: Phase 5 hardware validation — <fixture type> at address <N> on <date>`

### Exit criteria
- PxO can fire a fogger blast via `{ command: "burst", duration_ms: 1200 }` and trust PxB to cut output on time.
- An unhandled crash mid-burst leaves the fogger channel at 0 (verified via Phase 0 fixture standing in for the fogger).

### Recommended AI model
- **Claude Sonnet — Medium**
- Timer semantics + safety caps are the tricky bits but well within Medium's wheelhouse.

---

## 10. Phase 6 — Motion / Movers (independent)

**Goal:** Drive pan/tilt fixtures with named positions instead of raw DMX channel values.

### Design
- Expand the `mover-basic` profile (Phase 3) into a richer one (`mover-8ch`, `mover-12ch`) with `pan`, `tilt`, `pan_fine`, `tilt_fine`, `speed`, `dimmer`, `color`, `gobo` slots.
- Per-fixture INI:
  ```ini
  [light:mover-1]
  backend  = dmx
  fixture  = mover-8ch
  address  = 21
  positions = {"home":{"pan":128,"tilt":64},"door":{"pan":210,"tilt":80}}
  ```
- New commands:
  - `{ "command": "moveTo", "position": "door" }`
  - `{ "command": "moveTo", "pan": 210, "tilt": 80, "speed": 30 }`
  - `{ "command": "home" }`
- Reuse the existing light command surface for color/dimmer; only motion is additive.

### Tasks
- [x] Profile + positions schema (`mover-8ch`, `mover-12ch`; `pan_fine`/`tilt_fine` in `VALID_SLOTS`; `positions` key in `src/config/schema.js`).
- [x] Adapter routing for `moveTo` / `home` (`_resolvePosition`, `_applyPosition`, `_parsePositions`; `pan`/`tilt` state; `moved` event).
- [x] Document in `docs/MQTT_API.md` §9c (mover commands, state shape, events, warning codes).
- [x] Document `positions` key in `docs/CONFIG_INI.md`.
- [x] Document `mover-8ch` and `mover-12ch` in `docs/DMX_FIXTURES.md`.
- [x] Unit tests with mock universe and a fake position table (11 new tests; total 469 passing).
- [ ] Hardware validation against an entry-level moving head fixture — see checklist below.

### Exit criteria
- Operators define named positions in INI; PxO can call `moveTo` by name.
- Mixed light/mover use in the same room works.

### Hardware validation checklist (Phase 6)

- [ ] Patch a moving head to a known DMX start address. Set `fixture = mover-8ch` (or `mover-12ch`) and `address` accordingly in INI.
- [ ] Start PxB; confirm adapter shows `ready` in `{light.topic}/state`. State should include `pan: null, tilt: null`.
- [ ] Publish `{ "command": "home" }`. Confirm the fixture moves to its home position. State should update with `pan: 128, tilt: 128`.
- [ ] Publish `{ "command": "moveTo", "pan": 60, "tilt": 100 }`. Confirm the head tracks to the expected physical position.
- [ ] Add a `positions` JSON string in INI. Publish `{ "command": "moveTo", "position": "stage-left" }`. Confirm the head tracks to the named position.
- [ ] Publish `{ "command": "moveTo", "position": "nowhere" }`. Confirm `DMX_POSITION_UNKNOWN` warning on the warnings topic. Fixture does not move.
- [ ] For `mover-12ch`: verify `pan_fine` and `tilt_fine` channels are 0 after a `moveTo`.
- [ ] Confirm color/dimmer commands (`setColor`, `setBrightness`) still work alongside motion commands.
- [ ] Mark this checklist complete and record fixture model and firmware version here once validated.

### Recommended AI model
- **Claude Sonnet — Medium**

---

## 11. Phase 7 — Multi-Universe, Fade, Strobe, Blackout, Recording

**Status: Implemented** — see commit `Implement: Phase 7`.

Candidate work items, each a separate PR:
- [x] Multiple `[dmx:<label>]` universes in one PxB process.
- [x] Server-side `fade` command with `fadeTime` parameter (linear interpolation at 30 Hz).
- [x] Software `setStrobe` / `stopStrobe` (Hz / duty cycle; max 25 Hz; per-color).
- [x] Hardware strobe passthrough `setDmxStrobe` / `dmxStrobeOff` (requires `strobe` capability).
- [x] Universe blackout master (`masterBlackout`/`masterRestore`) with bridge-level `dmxBlackoutAll`/`dmxRestoreAll`.
- [x] DMX recording (frame-level `startRecording` / `stopRecording` / `playRecording` / `stopPlayback`).
- [x] `tools/dmx-demo/demo.js` — four-sequence visual demo script.

Remaining stretch items (not yet scheduled):
- sACN (E1.31) and Art-Net network DMX as additional `interface =` values.
- Named scene cues with sequenced transitions.

### Recommended AI model
- **Claude Sonnet — High** for protocol work (sACN/Art-Net) and scene engine timing.
- **Claude Sonnet — Medium** for everything else.

---

## 12. Cross-Cutting Decisions

These are decided once, up front, so every phase agrees:

- [ ] **Serial library:** `serialport` (Node), pinned to a major with prebuilt aarch64 binaries.
- [ ] **Single writer rule:** PxB is the only process opening any DMX serial port. No PFx or room helper may open `/dev/ttyUSB*` for DMX once Phase 1 ships.
- [ ] **Device access:** udev rule under `config/udev/` granting the `paradox` user access to `0403:6001` without `dialout` membership (so service installs don't need group manipulation).
- [ ] **Naming:** the universe writer lives under `src/dmx/`, not `src/radios/dmx/`. DMX is not a radio.
- [ ] **Topic shape:** unchanged — `[light:*]`, `[effect:*]`, `[light-zone:*]` all use the same `{base_topic}/{commands|state|events|warnings}` contract.
- [ ] **Heartbeat:** add `radios.dmx` (or a sibling key `buses.dmx`) with `{ enabled, connected, port, interface, refresh_hz, frame_count, last_error }`. Decide before Phase 1.
- [ ] **Doc-first rule:** every phase updates `docs/SPEC.md`, `docs/CONFIG_INI.md`, and `docs/MQTT_API.md` in the same commit as the implementation (PxB methodology).

---

## 13. Testing Posture

- **Unit tests** for every phase, mocked serial interface. Land in `test/unit/dmx/`, `test/unit/lights/`, `test/unit/effects/`.
- **Manual hardware tests** on the Pi5 with at least one cheap RGB par (Phase 2) and one fogger or fogger-stand-in relay (Phase 5).
- **Integration tests** with the live MQTT broker only after Phase 2 (so we have a realistic command surface). Keep them behind `npm run test:integration` (not added to default CI) per PxB convention.
- **Reliability check:** at the end of Phase 2 and again at the end of Phase 4, run a 30-minute continuous-frame test under simulated load (`stress -c 4`) and confirm no fixture flicker.

---

## 14. Risks and Open Questions

- **FTDI timing under Node:** the Open DMX path depends on user-space timing. If Phase 0 or the Phase 2 reliability check is shaky, we may need to gate production rooms on Phase 4 hardware.
- **`serialport` native build on Pi5:** verify aarch64 prebuilt during Phase 1; if not available, document the build-from-source path in `QUICK_START_DMX.md`.
- **PFx overlap:** PFx today does not own DMX. Confirm no room currently expects PFx to drive DMX before Phase 2 lands.
- **PxO commands:** PxO already speaks the generic light command set, so Phase 2 should "just work" for lights. Effects (Phase 5) introduce new commands; coordinate with PxO before Phase 5 starts to avoid command-name churn.
- **Sharing one universe across many fixtures:** the universe writer must be the sole owner of the frame buffer. The plan keeps fixture adapters as readers/writers of channel ranges, not owners of the port. Verify in Phase 2 unit tests that two adapters writing adjacent channels never lose updates.

---

## 15. Phase Summary Table

| Phase | Deliverable | Depends on | Suggested model |
|---|---|---|---|
| 0 | Hardware validation (out-of-tree) | — | Sonnet / Medium |
| 1 | DMX universe writer + Open DMX backend | 0 | Sonnet / High (writer), Sonnet / Medium (config + tests) |
| 2 | `backend = dmx` light adapter (dimmer + rgb) | 1 | Sonnet / Medium |
| 3 | Fixture profile library (rgbw/rgba/rgbaw/rgbawuv/par/custom) | 2 | Sonnet / Medium |
| 4 | Enttec DMX USB Pro backend | 1 (and ideally 2 for test surface) | Sonnet / High (framing), Sonnet / Medium (rest) |
| 5 | `[effect:*]` adapter (foggers, strobes, hazers) | 2 | Sonnet / Medium |
| 6 | Motion / movers with named positions | 2 (and 3 if mover profiles graduated there) | Sonnet / Medium |
| 7 | Multi-universe, scenes, sACN/Art-Net (stretch) | 1 | Sonnet / High (protocols), Sonnet / Medium (rest) |

---

## 16. Acceptance for "DMX Support Shipped"

PxB is considered to have first-class DMX support once Phases 1, 2, and 3 are merged on `main` and a real Houdini-class room is driving at least one DMX fixture in production through PxB for ≥ one full game cycle without a fixture-level issue. Phases 4–7 are post-ship enhancements.
