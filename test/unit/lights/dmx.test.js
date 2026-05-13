'use strict';

const DmxAdapter = require('../../../src/lights/dmx');

// ── Mock factory helpers ──────────────────────────────────────────────────

function mockUniverse() {
    const channels = {};
    return {
        channels,
        setChannel: jest.fn((ch, v) => { channels[ch] = v; }),
        setChannels: jest.fn((map) => { Object.assign(channels, map); }),
    };
}

function mockMqtt() {
    const mqtt = {
        _subs: {},
        publish: jest.fn().mockResolvedValue(undefined),
        subscribe: jest.fn((topic, cb) => { mqtt._subs[topic] = cb; return Promise.resolve(); }),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
    };
    return mqtt;
}

function mockLogger() {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeAdapter(overrides = {}) {
    const universe = overrides.universe ?? mockUniverse();
    const mqtt     = overrides.mqtt ?? mockMqtt();
    const logger   = overrides.logger ?? mockLogger();
    const config   = {
        topic:    'paradox/test/lights/dmx1',
        fixture:  'rgb',
        address:  1,
        brightness: 100,
        ...overrides.config,
    };
    return {
        adapter: new DmxAdapter({ config, mqttClient: mqtt, logger, universe }),
        universe,
        mqtt,
        logger,
    };
}

// Send a command through the subscribed handler (simulates MQTT delivery)
async function sendCmd(mqtt, payload) {
    const cb = mqtt._subs['paradox/test/lights/dmx1/commands'];
    if (!cb) throw new Error('Adapter not subscribed (call init() first)');
    // Real dispatcher calls fn(topic, parsedPayload) — pass object, not JSON string
    await cb('paradox/test/lights/dmx1/commands', payload);
    // Flush async work started inside safeCall (which is not awaited by the cb)
    await new Promise(setImmediate);
}

// ── Constructor ───────────────────────────────────────────────────────────

describe('DmxAdapter — constructor', () => {
    it('throws if universe is not provided', () => {
        expect(() => new DmxAdapter({
            config: { topic: 't', fixture: 'rgb', address: 1 },
            mqttClient: mockMqtt(),
            logger: mockLogger(),
            universe: null,
        })).toThrow(/universe is required/);
    });

    it('throws if fixture is unknown', () => {
        expect(() => makeAdapter({ config: { topic: 't', fixture: 'unknown-profile', address: 1 } }))
            .toThrow(/unknown fixture/);
    });

    it('throws if address + channel_count > 512', () => {
        // rgb has 3 channels; address 511 → last slot 513
        expect(() => makeAdapter({ config: { topic: 't', fixture: 'rgb', address: 511 } }))
            .toThrow(/exceeding DMX 512-slot limit/);
    });

    it('constructs successfully for valid dimmer config', () => {
        expect(() => makeAdapter({ config: { topic: 't', fixture: 'dimmer', address: 1 } }))
            .not.toThrow();
    });

    it('constructs successfully for valid rgb config', () => {
        expect(() => makeAdapter({ config: { topic: 't', fixture: 'rgb', address: 1 } }))
            .not.toThrow();
    });
});

// ── init() ────────────────────────────────────────────────────────────────

describe('DmxAdapter — init()', () => {
    it('subscribes to commands topic', async () => {
        const { adapter, mqtt } = makeAdapter();
        await adapter.init();
        expect(mqtt.subscribe).toHaveBeenCalledWith(
            'paradox/test/lights/dmx1/commands',
            expect.any(Function)
        );
    });

    it('publishes an initial blacked-out state', async () => {
        const { adapter, mqtt } = makeAdapter();
        await adapter.init();
        expect(mqtt.publish).toHaveBeenCalledWith(
            'paradox/test/lights/dmx1/state',
            expect.stringContaining('"on":false'),
            expect.objectContaining({ retain: true })
        );
    });
});

// ── channel maths — dimmer profile ────────────────────────────────────────

describe('DmxAdapter — dimmer profile channel maths', () => {
    it('on at address writes 255 to the dimmer channel', async () => {
        const { adapter, mqtt, universe } = makeAdapter({
            config: { topic: 'paradox/test/lights/dmx1', fixture: 'dimmer', address: 5 },
        });
        await adapter.init();
        await sendCmd(mqtt, { command: 'on' });
        expect(universe.setChannel).toHaveBeenCalledWith(5, expect.any(Number));
        expect(universe.setChannel.mock.calls.some(([ch, v]) => ch === 5 && v > 0)).toBe(true);
    });

    it('off writes 0 to the dimmer channel', async () => {
        const { adapter, mqtt, universe } = makeAdapter({
            config: { topic: 'paradox/test/lights/dmx1', fixture: 'dimmer', address: 5 },
        });
        await adapter.init();
        await sendCmd(mqtt, { command: 'on' });
        await sendCmd(mqtt, { command: 'off' });
        const lastCall = universe.setChannel.mock.calls
            .filter(([ch]) => ch === 5)
            .pop();
        expect(lastCall[1]).toBe(0);
    });

    it('setBrightness 50 writes ~128 (50% of 255) to address', async () => {
        const { adapter, mqtt, universe } = makeAdapter({
            config: { topic: 'paradox/test/lights/dmx1', fixture: 'dimmer', address: 3 },
        });
        await adapter.init();
        await sendCmd(mqtt, { command: 'setBrightness', brightness: 50 });
        const lastCall = universe.setChannel.mock.calls
            .filter(([ch]) => ch === 3)
            .pop();
        // 50 * 2.55 = 127.5 → Math.round(127.5) = 127 in JS (rounds to even)
        expect(lastCall[1]).toBe(127);
    });
});

// ── channel maths — rgb profile ───────────────────────────────────────────

describe('DmxAdapter — rgb profile channel maths', () => {
    it('setColor { r:255, g:0, b:0 } writes full red at address, 0 at +1 and +2', async () => {
        const { adapter, mqtt, universe } = makeAdapter({
            config: { topic: 'paradox/test/lights/dmx1', fixture: 'rgb', address: 10, brightness: 100 },
        });
        await adapter.init();
        await sendCmd(mqtt, { command: 'setColor', color: { r: 255, g: 0, b: 0 }, brightness: 100 });
        expect(universe.setChannels).toHaveBeenCalledWith(expect.objectContaining({
            10: 255,
            11: 0,
            12: 0,
        }));
    });

    it('setColor with hex #00FF00 writes green at address+1', async () => {
        const { adapter, mqtt, universe } = makeAdapter({
            config: { topic: 'paradox/test/lights/dmx1', fixture: 'rgb', address: 1, brightness: 100 },
        });
        await adapter.init();
        await sendCmd(mqtt, { command: 'setColor', color: '#00FF00', brightness: 100 });
        expect(universe.setChannels).toHaveBeenCalledWith(expect.objectContaining({
            1: 0,
            2: 255,
            3: 0,
        }));
    });

    it('setBrightness 50 scales current colour by 50%', async () => {
        const { adapter, mqtt, universe } = makeAdapter({
            config: { topic: 'paradox/test/lights/dmx1', fixture: 'rgb', address: 1 },
        });
        await adapter.init();
        // Set full red at 100%
        await sendCmd(mqtt, { command: 'setColor', color: { r: 200, g: 0, b: 100 }, brightness: 100 });
        // Now halve brightness
        await sendCmd(mqtt, { command: 'setBrightness', brightness: 50 });
        const lastChannelCall = universe.setChannels.mock.calls.pop();
        expect(lastChannelCall[0][1]).toBe(100);   // 200 * 0.5
        expect(lastChannelCall[0][2]).toBe(0);
        expect(lastChannelCall[0][3]).toBe(50);    // 100 * 0.5
    });

    it('off zeros all three channels', async () => {
        const { adapter, mqtt, universe } = makeAdapter({
            config: { topic: 'paradox/test/lights/dmx1', fixture: 'rgb', address: 7 },
        });
        await adapter.init();
        await sendCmd(mqtt, { command: 'on' });
        universe.setChannel.mockClear();
        await sendCmd(mqtt, { command: 'off' });
        // blackout calls setChannel for each channel slot
        expect(universe.setChannel).toHaveBeenCalledWith(7, 0);
        expect(universe.setChannel).toHaveBeenCalledWith(8, 0);
        expect(universe.setChannel).toHaveBeenCalledWith(9, 0);
    });
});

// ── setColorScene ─────────────────────────────────────────────────────────

describe('DmxAdapter — setColorScene', () => {
    it('applies built-in "red" scene for rgb fixture', async () => {
        const { adapter, mqtt, universe } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'setColorScene', scene: 'red' });
        // DEFAULT_SCENE_MAP.red = { r:255, g:0, b:0, brightness:80 } → 255*0.8=204
        expect(universe.setChannels).toHaveBeenCalledWith(expect.objectContaining({ 1: 204, 2: 0, 3: 0 }));
    });

    it('applies "off" scene and marks state.on = false', async () => {
        const { adapter, mqtt } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'setColorScene', scene: 'red' });
        await sendCmd(mqtt, { command: 'setColorScene', scene: 'off' });
        // State publish last call should have "on":false
        const lastPublish = mqtt.publish.mock.calls.reverse().find(
            ([topic]) => topic.endsWith('/state')
        );
        expect(JSON.parse(lastPublish[1]).on).toBe(false);
    });

    it('publishes warning for unknown scene name', async () => {
        const { adapter, mqtt } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'setColorScene', scene: 'doesNotExist' });
        expect(mqtt.publish).toHaveBeenCalledWith(
            expect.stringContaining('/warnings'),
            expect.stringContaining('DMX_SCENE_UNKNOWN'),
            expect.any(Object)
        );
    });

    it('dimmer scene uses brightness only (no rgb channels written)', async () => {
        const { adapter, mqtt, universe } = makeAdapter({
            config: { topic: 'paradox/test/lights/dmx1', fixture: 'dimmer', address: 2 },
        });
        await adapter.init();
        await sendCmd(mqtt, { command: 'setColorScene', scene: 'dim' });
        // Should only call setChannel(2, ...) — not setChannels with rgb keys
        expect(universe.setChannels).not.toHaveBeenCalled();
        expect(universe.setChannel).toHaveBeenCalledWith(2, expect.any(Number));
    });
});

// ── Unsupported commands ──────────────────────────────────────────────────

describe('DmxAdapter — unsupported commands', () => {
    it('publishes DMX_CMD_UNSUPPORTED warning for "fade"', async () => {
        const { adapter, mqtt } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'fade', brightness: 10, duration: 2 });
        expect(mqtt.publish).toHaveBeenCalledWith(
            expect.stringContaining('/warnings'),
            expect.stringContaining('DMX_CMD_UNSUPPORTED'),
            expect.any(Object)
        );
    });

    it('publishes DMX_CMD_UNSUPPORTED warning for "setColorTemp"', async () => {
        const { adapter, mqtt } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'setColorTemp', kelvin: 3000 });
        expect(mqtt.publish).toHaveBeenCalledWith(
            expect.stringContaining('/warnings'),
            expect.stringContaining('DMX_CMD_UNSUPPORTED'),
            expect.any(Object)
        );
    });

    it('setColor on a dimmer fixture publishes DMX_CMD_UNSUPPORTED', async () => {
        const { adapter, mqtt } = makeAdapter({
            config: { topic: 'paradox/test/lights/dmx1', fixture: 'dimmer', address: 1 },
        });
        await adapter.init();
        await sendCmd(mqtt, { command: 'setColor', color: { r: 255, g: 0, b: 0 } });
        expect(mqtt.publish).toHaveBeenCalledWith(
            expect.stringContaining('/warnings'),
            expect.stringContaining('DMX_CMD_UNSUPPORTED'),
            expect.any(Object)
        );
    });

    it('publishes DMX_CMD_UNKNOWN for completely unknown command', async () => {
        const { adapter, mqtt } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'blastWithLasers' });
        expect(mqtt.publish).toHaveBeenCalledWith(
            expect.stringContaining('/warnings'),
            expect.stringContaining('DMX_CMD_UNKNOWN'),
            expect.any(Object)
        );
    });
});

// ── State publishing ──────────────────────────────────────────────────────

describe('DmxAdapter — state publishing', () => {
    it('state payload includes fixture and address', async () => {
        const { adapter, mqtt } = makeAdapter({
            config: { topic: 'paradox/test/lights/dmx1', fixture: 'rgb', address: 10 },
        });
        await adapter.init();
        const stateCall = mqtt.publish.mock.calls.find(([t]) => t.endsWith('/state'));
        const state = JSON.parse(stateCall[1]);
        expect(state.fixture).toBe('rgb');
        expect(state.address).toBe(10);
    });

    it('getState re-publishes retained state', async () => {
        const { adapter, mqtt } = makeAdapter();
        await adapter.init();
        const countBefore = mqtt.publish.mock.calls.filter(([t]) => t.endsWith('/state')).length;
        await sendCmd(mqtt, { command: 'getState' });
        const countAfter  = mqtt.publish.mock.calls.filter(([t]) => t.endsWith('/state')).length;
        expect(countAfter).toBeGreaterThanOrEqual(countBefore + 1);
    });
});

// ── dispose() ────────────────────────────────────────────────────────────

describe('DmxAdapter — dispose()', () => {
    it('zeros fixture channels on dispose', async () => {
        const { adapter, mqtt, universe } = makeAdapter({
            config: { topic: 'paradox/test/lights/dmx1', fixture: 'rgb', address: 4 },
        });
        await adapter.init();
        await sendCmd(mqtt, { command: 'setColor', color: { r: 200, g: 100, b: 50 }, brightness: 100 });
        universe.setChannel.mockClear();
        await adapter.dispose();
        // blackout called for ch 4, 5, 6
        expect(universe.setChannel).toHaveBeenCalledWith(4, 0);
        expect(universe.setChannel).toHaveBeenCalledWith(5, 0);
        expect(universe.setChannel).toHaveBeenCalledWith(6, 0);
    });

    it('unsubscribes from commands on dispose', async () => {
        const { adapter, mqtt } = makeAdapter();
        await adapter.init();
        await adapter.dispose();
        expect(mqtt.unsubscribe).toHaveBeenCalledWith(
            'paradox/test/lights/dmx1/commands'
        );
    });
});
