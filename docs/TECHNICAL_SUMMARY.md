# PxB Technical Summary

This document is a short reviewer-oriented overview of what PxB implements and why the codebase is interesting from an engineering perspective.

## Scope

PxB is a Node.js bridge that owns local Z-Wave and Zigbee radios and exposes a stable MQTT contract for downstream consumers. It also includes direct output adapters for networked lighting and relay hardware used elsewhere in the Paradox stack.

The project sits at the boundary between:

- hardware integration
- service lifecycle management
- configuration-driven runtime composition
- MQTT API design
- adapter-oriented application structure

## Notable Implementation Areas

## 1. Driver Lifecycle and Fault Handling

The bridge manages long-lived radio drivers, heartbeat publishing, reconnect behavior, inclusion/exclusion flows, and warning surfaces. That work is concentrated in the bridge and radio modules rather than being mixed into feature code.

## 2. Contract-First MQTT Design

The repo documents and enforces a consistent `{commands|events|state|warnings}` topic model. Retained state, on-change publishing, and discovery notices are part of the design rather than incidental behavior.

## 3. Config-Driven Composition

The runtime is assembled from INI configuration rather than hard-coded room logic. That includes radio nodes, direct output adapters, and generic light-zone fan-out groups.

## 4. Adapter Architecture

Output integrations are split into focused adapters for Hue, WiZ, LIFX, Shelly, and grouped light zones. The grouped light layer is backend-agnostic, which allows mixed-vendor room groupings while keeping backend-specific behavior inside each adapter.

## 5. Testing Discipline

The codebase has broad unit coverage over config loading, MQTT contract helpers, discovery generation, node registry behavior, inclusion flows, radio driver behavior, and output adapters. The current unit suite passes cleanly without relying on forced Jest termination.

## What A Reviewer Should Expect

- Clear separation between bridge concerns, driver concerns, and output-adapter concerns
- Documentation that mostly matches the implemented runtime and contract
- Honest hardware caveats where live coordinator behavior is still device-dependent
- A codebase optimized for operational clarity more than framework cleverness

## Current Caveats

- Some live Zigbee validation remains hardware-specific; the repo documents the HUSBZB-1 limitation explicitly.
- The codebase is operational and test-backed, but there is still normal hardening work available beyond the implemented baseline.

## Suggested Review Path

1. Start with `README.md` and `docs/MQTT_API.md` for the system contract.
2. Read `src/index.js` to see service composition and lifecycle wiring.
3. Inspect `src/radios/zwave/driver.js`, `src/radios/zigbee/driver.js`, and `src/bridge/` for runtime behavior.
4. Inspect `src/lights/` and `src/switches/` for adapter design.
5. Scan `test/unit/` to see the validation surface.