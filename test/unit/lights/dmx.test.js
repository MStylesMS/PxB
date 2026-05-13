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
            .toThrow(/[Uu]nknown fixture/);
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
    it('fade with fadeTime=0 applies brightness immediately', async () => {
        const { adapter, universe, mqtt } = makeAdapter({ config: { fixture: 'par-7ch', address: 1 } });
        await adapter.init();
        await sendCmd(mqtt, { command: 'fade', brightness: 50, fadeTime: 0 });
        // dimmer channel (ch 1 for par-7ch) should be ~50% = ~128
        expect(universe.channels[1]).toBeGreaterThanOrEqual(125);
        expect(universe.channels[1]).toBeLessThanOrEqual(130);
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

// ── Mover commands (moveTo / home) ────────────────────────────────────────

describe('Mover commands', () => {
    function makeMoverAdapter(overrides = {}) {
        return makeAdapter({
            ...overrides,
            config: { fixture: 'mover-8ch', address: 1, ...overrides.config },
        });
    }

    it('constructs mover-8ch without throwing', () => {
        expect(() => makeMoverAdapter()).not.toThrow();
    });

    it('constructs mover-12ch without throwing', () => {
        expect(() => makeMoverAdapter({ config: { fixture: 'mover-12ch', address: 1 } })).not.toThrow();
    });

    it('moveTo by raw pan/tilt sets channels', async () => {
        const { adapter, mqtt, universe } = makeMoverAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'moveTo', pan: 100, tilt: 200 });
        // pan is ch1, tilt is ch2 for mover-8ch
        expect(universe.setChannels).toHaveBeenCalledWith(expect.objectContaining({ 1: 100, 2: 200 }));
    });

    it('moveTo by named position sets channels', async () => {
        const positions = JSON.stringify({ stage: { pan: 60, tilt: 80 } });
        const { adapter, mqtt, universe } = makeMoverAdapter({ config: { fixture: 'mover-8ch', address: 1, positions } });
        await adapter.init();
        await sendCmd(mqtt, { command: 'moveTo', position: 'stage' });
        expect(universe.setChannels).toHaveBeenCalledWith(expect.objectContaining({ 1: 60, 2: 80 }));
    });

    it('moveTo with unknown position publishes DMX_POSITION_UNKNOWN warning', async () => {
        const { adapter, mqtt } = makeMoverAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'moveTo', position: 'nowhere' });
        const warningCalls = mqtt.publish.mock.calls.filter(
            ([t]) => t.endsWith('/warnings')
        );
        expect(warningCalls.length).toBeGreaterThan(0);
        const body = JSON.parse(warningCalls[0][1]);
        expect(body.code).toBe('DMX_POSITION_UNKNOWN');
    });

    it('moveTo without position name or raw values publishes DMX_CMD_INVALID', async () => {
        const { adapter, mqtt } = makeMoverAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'moveTo' });
        const warningCalls = mqtt.publish.mock.calls.filter(
            ([t]) => t.endsWith('/warnings')
        );
        expect(warningCalls.length).toBeGreaterThan(0);
        const body = JSON.parse(warningCalls[0][1]);
        expect(body.code).toBe('DMX_CMD_INVALID');
    });

    it('home uses default home position pan=128, tilt=128', async () => {
        const { adapter, mqtt, universe } = makeMoverAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'home' });
        expect(universe.setChannels).toHaveBeenCalledWith(expect.objectContaining({ 1: 128, 2: 128 }));
    });

    it('home uses custom home position from positions config', async () => {
        const positions = JSON.stringify({ home: { pan: 10, tilt: 20 } });
        const { adapter, mqtt, universe } = makeMoverAdapter({ config: { fixture: 'mover-8ch', address: 1, positions } });
        await adapter.init();
        await sendCmd(mqtt, { command: 'home' });
        expect(universe.setChannels).toHaveBeenCalledWith(expect.objectContaining({ 1: 10, 2: 20 }));
    });

    it('moveTo on non-mover fixture publishes DMX_CMD_UNSUPPORTED', async () => {
        const { adapter, mqtt } = makeAdapter({ config: { fixture: 'rgb', address: 1 } });
        await adapter.init();
        await sendCmd(mqtt, { command: 'moveTo', pan: 100, tilt: 100 });
        const warningCalls = mqtt.publish.mock.calls.filter(
            ([t]) => t.endsWith('/warnings')
        );
        expect(warningCalls.length).toBeGreaterThan(0);
        const body = JSON.parse(warningCalls[0][1]);
        expect(body.code).toBe('DMX_CMD_UNSUPPORTED');
    });

    it('getState includes pan/tilt for mover fixture', async () => {
        const { adapter, mqtt } = makeMoverAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'moveTo', pan: 50, tilt: 75 });
        mqtt.publish.mockClear();
        await sendCmd(mqtt, { command: 'getState' });
        const stateCalls = mqtt.publish.mock.calls.filter(([t]) => t.endsWith('/state'));
        expect(stateCalls.length).toBeGreaterThan(0);
        const state = JSON.parse(stateCalls[stateCalls.length - 1][1]);
        expect(state.pan).toBe(50);
        expect(state.tilt).toBe(75);
    });

    it('mover-12ch zeros pan_fine and tilt_fine channels on moveTo', async () => {
        const { adapter, mqtt, universe } = makeMoverAdapter({ config: { fixture: 'mover-12ch', address: 1 } });
        await adapter.init();
        await sendCmd(mqtt, { command: 'moveTo', pan: 90, tilt: 110 });
        // channels: pan=1, pan_fine=2, tilt=3, tilt_fine=4
        const call = universe.setChannels.mock.calls[universe.setChannels.mock.calls.length - 1][0];
        expect(call[1]).toBe(90);  // pan
        expect(call[2]).toBe(0);   // pan_fine
        expect(call[3]).toBe(110); // tilt
        expect(call[4]).toBe(0);   // tilt_fine
    });
});

// ── Fade ─────────────────────────────────────────────────────────────────

describe('DmxAdapter — fade', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    function flushMicrotasks() {
        return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    }

    it('setBrightness with fadeTime>0 interpolates channels', async () => {
        const { adapter, universe } = makeAdapter({ config: { fixture: 'par-7ch', address: 1 } });
        await adapter.init();
        // Turn on first so we have a non-zero start
        const mqtt = adapter.mqttClient;  // we need to reach the mqtt from adapter

        // Actually use the universe for validation — just use fresh adapter approach
        // We'll verify fade reaches target brightness after full duration
        const { adapter: a, universe: u, mqtt: m } = makeAdapter({ config: { fixture: 'par-7ch', address: 1 } });
        await a.init();

        // Set initial brightness to 0 (blackout on init)
        // Now fade to brightness 100 over 1 second
        const cb = m._subs['paradox/test/lights/dmx1/commands'];
        await cb('', { command: 'setBrightness', brightness: 100, fadeTime: 1 });
        await flushMicrotasks();

        // Before any tick: dimmer should still be 0 (or the initial value)
        const before = u.channels[1] ?? 0;
        expect(before).toBeLessThan(200);

        // Advance past the full fade duration (1000ms)
        jest.advanceTimersByTime(1100);
        await flushMicrotasks();

        // After full fade: dimmer channel should be 255
        expect(u.channels[1]).toBe(255);
    });

    it('second command cancels in-progress fade', async () => {
        const { adapter: a, universe: u, mqtt: m } = makeAdapter({ config: { fixture: 'par-7ch', address: 1 } });
        await a.init();
        const cb = m._subs['paradox/test/lights/dmx1/commands'];

        // Start a 2-second fade
        await cb('', { command: 'setBrightness', brightness: 100, fadeTime: 2 });
        await flushMicrotasks();

        // Advance 500ms — fade is mid-way
        jest.advanceTimersByTime(500);
        await flushMicrotasks();

        // Issue immediate setBrightness — should cancel fade and snap to 0
        await cb('', { command: 'setBrightness', brightness: 0 });
        await flushMicrotasks();

        expect(u.channels[1]).toBe(0);

        // Advance more time — should NOT continue fading
        jest.advanceTimersByTime(2000);
        await flushMicrotasks();
        expect(u.channels[1]).toBe(0);
    });

    it('on with fadeTime>0 starts fade', async () => {
        const { adapter: a, universe: u, mqtt: m } = makeAdapter({ config: { fixture: 'par-7ch', address: 1 } });
        await a.init();
        const cb = m._subs['paradox/test/lights/dmx1/commands'];

        await cb('', { command: 'on', brightness: 100, fadeTime: 1 });
        await flushMicrotasks();

        // Initial channel still low; advance full duration
        jest.advanceTimersByTime(1100);
        await flushMicrotasks();

        expect(u.channels[1]).toBe(255);
    });

    it('off with fadeTime>0 fades to zero', async () => {
        const { adapter: a, universe: u, mqtt: m } = makeAdapter({ config: { fixture: 'par-7ch', address: 1 } });
        await a.init();
        const cb = m._subs['paradox/test/lights/dmx1/commands'];

        // Turn on first
        await cb('', { command: 'on', brightness: 100 });
        await flushMicrotasks();
        expect(u.channels[1]).toBe(255);

        // Fade off
        await cb('', { command: 'off', fadeTime: 0.5 });
        await flushMicrotasks();

        jest.advanceTimersByTime(600);
        await flushMicrotasks();

        expect(u.channels[1]).toBe(0);
    });
});

// ── Software strobe ──────────────────────────────────────────────────────

describe('DmxAdapter — software strobe', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    async function flush() {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    }

    it('setStrobe alternates channels on/off at given Hz', async () => {
        const { adapter: a, universe: u, mqtt: m } = makeAdapter({ config: { fixture: 'rgb', address: 1 } });
        await a.init();
        const cb = m._subs['paradox/test/lights/dmx1/commands'];

        // 1 Hz, 50% duty = 500ms on, 500ms off
        await cb('', { command: 'setStrobe', strobeHz: 1, strobeDuty: 50,
            color: { r: 255, g: 255, b: 255 }, brightness: 100 });
        await flush();

        // Immediately after setStrobe the on-phase runs: R=255
        expect(u.channels[1]).toBe(255); // red ch 1

        // Advance past on-phase into off-phase
        jest.advanceTimersByTime(510);
        await flush();
        expect(u.channels[1]).toBe(0);   // off-phase: zeroed

        // Advance past off-phase back to on-phase
        jest.advanceTimersByTime(510);
        await flush();
        expect(u.channels[1]).toBe(255); // on again
    });

    it('stopStrobe cancels strobe and applies blackout by default', async () => {
        const { adapter: a, universe: u, mqtt: m } = makeAdapter({ config: { fixture: 'rgb', address: 1 } });
        await a.init();
        const cb = m._subs['paradox/test/lights/dmx1/commands'];

        await cb('', { command: 'setStrobe', strobeHz: 2, strobeDuty: 50,
            color: { r: 255, g: 0, b: 0 }, brightness: 100 });
        await flush();

        await cb('', { command: 'stopStrobe' });
        await flush();

        expect(u.channels[1]).toBe(0);   // red = 0 (blackout)
        expect(u.channels[2]).toBe(0);   // green = 0
        expect(u.channels[3]).toBe(0);   // blue = 0

        // Timer no longer fires
        jest.advanceTimersByTime(2000);
        await flush();
        expect(u.channels[1]).toBe(0);
    });

    it('stopStrobe with brightness param restores to that brightness', async () => {
        const { adapter: a, universe: u, mqtt: m } = makeAdapter({ config: { fixture: 'par-7ch', address: 1 } });
        await a.init();
        const cb = m._subs['paradox/test/lights/dmx1/commands'];

        await cb('', { command: 'setStrobe', strobeHz: 2, strobeDuty: 50,
            color: { r: 255, g: 255, b: 255 }, brightness: 100 });
        await flush();

        await cb('', { command: 'stopStrobe', brightness: 60 });
        await flush();

        // dimmer ch 1 for par-7ch: 60% = ~153
        expect(u.channels[1]).toBeGreaterThanOrEqual(150);
        expect(u.channels[1]).toBeLessThanOrEqual(156);
    });

    it('any output command cancels strobe', async () => {
        const { adapter: a, universe: u, mqtt: m } = makeAdapter({ config: { fixture: 'rgb', address: 1 } });
        await a.init();
        const cb = m._subs['paradox/test/lights/dmx1/commands'];

        await cb('', { command: 'setStrobe', strobeHz: 2, strobeDuty: 50 });
        await flush();

        // setColor with explicit brightness cancels strobe and applies color
        await cb('', { command: 'setColor', color: { r: 100, g: 50, b: 25 }, brightness: 100 });
        await flush();

        // rgb fixture no dimmer: ch1=red*scale = 100*(100/100) = 100
        expect(u.channels[1]).toBe(100); // red

        // No more strobe flipping
        jest.advanceTimersByTime(2000);
        await flush();
        expect(u.channels[1]).toBe(100);
    });

    it('Hz above MAX_STROBE_HZ is clamped with a warning', async () => {
        const { adapter: a, mqtt: m } = makeAdapter({ config: { fixture: 'rgb', address: 1 } });
        await a.init();
        const cb = m._subs['paradox/test/lights/dmx1/commands'];

        await cb('', { command: 'setStrobe', strobeHz: 99, strobeDuty: 50 });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

        const warns = m.publish.mock.calls.filter(([t]) => t.endsWith('/warnings'));
        expect(warns.length).toBeGreaterThan(0);
        const warnBody = JSON.parse(warns[warns.length - 1][1]);
        expect(warnBody.code).toBe('DMX_STROBE_HZ_CLAMPED');
    });

    it('state includes strobing fields while strobing', async () => {
        const { adapter: a, mqtt: m } = makeAdapter({ config: { fixture: 'rgb', address: 1 } });
        await a.init();
        const cb = m._subs['paradox/test/lights/dmx1/commands'];

        await cb('', { command: 'setStrobe', strobeHz: 5, strobeDuty: 40 });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

        const stateCalls = m.publish.mock.calls.filter(([t]) => t.endsWith('/state'));
        const last = JSON.parse(stateCalls[stateCalls.length - 1][1]);
        expect(last.strobing).toBe(true);
        expect(last.strobeHz).toBe(5);
        expect(last.strobeDuty).toBe(40);
    });
});

// ── Hardware strobe passthrough ───────────────────────────────────────────

describe('DmxAdapter — hardware strobe (setDmxStrobe/dmxStrobeOff)', () => {
    async function flush() {
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }

    it('setDmxStrobe sets strobe channel on a par-7ch fixture', async () => {
        const { adapter: a, universe: u, mqtt: m } = makeAdapter({ config: { fixture: 'par-7ch', address: 1 } });
        await a.init();
        const cb = m._subs['paradox/test/lights/dmx1/commands'];

        await cb('', { command: 'setDmxStrobe', value: 128 });
        await flush();

        // par-7ch channels at address 1: ch1=dimmer, ch2=red, ch3=green, ch4=blue, ch5=strobe, ch6=mode, ch7=speed
        expect(u.channels[5]).toBe(128);
    });

    it('dmxStrobeOff zeroes strobe channel', async () => {
        const { adapter: a, universe: u, mqtt: m } = makeAdapter({ config: { fixture: 'par-7ch', address: 1 } });
        await a.init();
        const cb = m._subs['paradox/test/lights/dmx1/commands'];

        await cb('', { command: 'setDmxStrobe', value: 200 });
        await flush();
        expect(u.channels[5]).toBe(200);

        await cb('', { command: 'dmxStrobeOff' });
        await flush();
        expect(u.channels[5]).toBe(0);
    });

    it('setDmxStrobe on rgb fixture (no strobe cap) publishes unsupported warning', async () => {
        const { adapter: a, mqtt: m } = makeAdapter({ config: { fixture: 'rgb', address: 1 } });
        await a.init();
        const cb = m._subs['paradox/test/lights/dmx1/commands'];

        await cb('', { command: 'setDmxStrobe', value: 128 });
        await flush();

        const warns = m.publish.mock.calls.filter(([t]) => t.endsWith('/warnings'));
        expect(warns.length).toBeGreaterThan(0);
        const body = JSON.parse(warns[warns.length - 1][1]);
        // _requireCapability publishes DMX_CMD_UNSUPPORTED then throws; the outer
        // catch re-publishes DMX_CMD_FAILED — check that any warning was issued.
        expect(['DMX_CMD_UNSUPPORTED', 'DMX_CMD_FAILED']).toContain(body.code);
    });

    it('dmxStrobeOff on rgb fixture is a no-op (no error)', async () => {
        const { adapter: a, universe: u, mqtt: m } = makeAdapter({ config: { fixture: 'rgb', address: 1 } });
        await a.init();
        const cb = m._subs['paradox/test/lights/dmx1/commands'];

        await cb('', { command: 'dmxStrobeOff' });
        await flush();

        const warns = m.publish.mock.calls.filter(([t]) => t.endsWith('/warnings'));
        // No warning expected — it's a no-op
        expect(warns.length).toBe(0);
    });
});
