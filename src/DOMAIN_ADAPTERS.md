# PxB I/O Domain Adapters

This directory contains the active PxB domain adapter implementations. Adapters are instantiated at startup based on the INI configuration and manage communication with external hardware backends.

## Adapter Domains

### `src/lights/` — Light Control Adapters
- **Hue** (`hue.js`) — Philips Hue light control
- **LIFX** (`lifx.js`) — LIFX smart light control
- **WiZ** (`wiz.js`) — WiZ light control
- **LightZoneAdapter** (`zone.js`) — Fan-out adapter for grouped light devices

**INI Configuration:**
```ini
[light:device_name]
backend = hue|lifx|wiz
topic = paradox/houdini/lights/device_name
...backend-specific keys

[light-zone:room_name]
topic = paradox/houdini/lights/room_name
devices = hue-main,wiz-84,lifx-desk
```

`[light-zone:*]` is backend-agnostic. A zone can mix Hue, WiZ, and LIFX members.
Commands are fanned out member-by-member, and each backend is expected to apply the
parts it supports while publishing warnings for unsupported requests.

### `src/switches/` — Smart Switch Adapters
- **Shelly** (`shelly.js`) — Shelly smart switches and relays

**INI Configuration:**
```ini
[switch:switch_name]
backend = shelly
topic = paradox/houdini/switches/switch_name
...backend-specific keys
```

## Adapter Contract

All adapters must extend `AdapterBase` and implement this interface:

```js
class MyAdapter extends AdapterBase {
    async init() {
        // Open connections, subscribe to MQTT topics, publish initial state
    }

    async executeCommand(payload) {
        // Execute inbound MQTT command
        // Publish warnings on non-fatal errors; throw on fatal errors
    }

    handleStateUpdate(state) {
        // Called when upstream state changes (radio event, etc.)
        // Publish {topic}/state message
    }

    async dispose() {
        // Clean up: close connections, unsubscribe, release timers
    }
}
```

See `src/adapter-base.js` for full JSDoc and helper methods (`publishWarning`, `publishState`, `publishEvent`).

## Testing

Each adapter has unit tests in `test/unit/<domain>/<adapter>.test.js`:
- Mock hardware / HTTP clients
- Inject MQTT client via constructor
- Test command execution and state updates
- Verify MQTT publishes (retain flags, topic paths, payload format)

Example test structure:
```js
describe('HueAdapter', () => {
    it('should execute setLight command', async () => {
        const mockMqtt = { publish: jest.fn() };
        const adapter = new HueAdapter({ config: {...}, mqttClient: mockMqtt, ... });
        await adapter.init();
        await adapter.executeCommand({ action: 'setLight', id: 1, on: true });
        expect(mockMqtt.publish).toHaveBeenCalled();
    });
});
```

## Integration with src/index.js

Adapters are loaded and managed in `src/index.js`:

1. **Config parsing:** INI sections named `[light:*]`, `[light-zone:*]`, `[switch:*]`, etc. are extracted
2. **Instantiation:** Adapters are constructed with shared MQTT client and logger
3. **Lifecycle:** `init()` called after MQTT connects; `dispose()` called on shutdown
4. **MQTT wiring:** Command handler subscribes to `{topic}/commands` and routes to `executeCommand()`

Domain adapters do **not** directly interact with radios (Z-Wave/Zigbee). Radio events flow through `NodeRegistry` → radio event handlers → adapter state updates.

## Dependencies

- `AdapterBase` from `src/adapter-base.js` — contract and helper methods
- `MqttClient` from `src/mqtt/client.js` — MQTT publishing (injected)
- Logger from `src/util/logger.js` — logging (injected)
- Backend-specific clients (Hue SDK, LIFX API, etc.) — installed as npm dependencies

## Status

**Current scope:**
- ✅ Directory structure created
- ✅ AdapterBase contract defined
- ✅ Config schema extended for lights, light zones, and switches
- ✅ Adapter loading hooks added to src/index.js
- ✅ Test scaffold created
- ✅ Active adapters implemented for Hue, WiZ, LIFX, Shelly, and grouped light zones

Radio-node aggregation belongs in PxO EDN or direct MQTT composition, not dormant
scaffolding inside PxB.
