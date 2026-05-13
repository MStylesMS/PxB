'use strict';

const DmxEffectAdapter = require('../../../src/effects/dmx');

// ── Mock factory helpers ──────────────────────────────────────────────────

function mockUniverse() {
    const channels = new Array(513).fill(0);
    return {
        channels,
        setChannel: jest.fn((ch, v) => { channels[ch] = v; }),
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

const DEFAULT_TOPIC = 'paradox/test/effects/fogger1';

function makeAdapter(overrides = {}) {
    const universe = overrides.universe ?? mockUniverse();
    const mqtt     = overrides.mqtt ?? mockMqtt();
    const logger   = overrides.logger ?? mockLogger();
    const config = {
        topic:       DEFAULT_TOPIC,
        fixture:     'fogger-1ch',
        address:     1,
        max_run_ms:  4000,
        intensity:   100,
        strobe_rate: 128,
        fan_speed:   0,
        ...overrides.config,
    };
    return {
        adapter: new DmxEffectAdapter({ config, mqttClient: mqtt, logger, universe }),
        universe,
        mqtt,
        logger,
    };
}

async function sendCmd(mqtt, payload) {
    const cb = mqtt._subs[`${DEFAULT_TOPIC}/commands`];
    if (!cb) throw new Error('Adapter not subscribed (call init() first)');
    await cb(`${DEFAULT_TOPIC}/commands`, payload);
    // Flush microtasks (safe with fake timers, unlike setImmediate).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

// ── Constructor ───────────────────────────────────────────────────────────

describe('DmxEffectAdapter — constructor', () => {
    it('throws if universe is not provided', () => {
        expect(() => new DmxEffectAdapter({
            config: { topic: 't', fixture: 'fogger-1ch', address: 1, max_run_ms: 4000, intensity: 100, strobe_rate: 128, fan_speed: 0 },
            mqttClient: mockMqtt(),
            logger: mockLogger(),
            universe: null,
        })).toThrow(/universe is required/);
    });

    it('throws if fixture lacks the effect capability', () => {
        // 'dimmer' is a light fixture, not an effect fixture
        expect(() => makeAdapter({ config: { fixture: 'dimmer' } }))
            .toThrow(/effect.*capability/i);
    });

    it('throws if address + channel_count exceeds 512', () => {
        expect(() => makeAdapter({ config: { fixture: 'fogger-1ch', address: 513 } }))
            .toThrow(/exceeding DMX 512-slot limit/);
    });

    it('constructs successfully for all four built-in effect fixtures', () => {
        for (const fixture of ['fogger-1ch', 'fogger-2ch', 'strobe-2ch', 'hazer-2ch']) {
            expect(() => makeAdapter({ config: { fixture } })).not.toThrow();
        }
    });
});

// ── init() ────────────────────────────────────────────────────────────────

describe('DmxEffectAdapter — init()', () => {
    it('subscribes to the commands topic', async () => {
        const { adapter, mqtt } = makeAdapter();
        await adapter.init();
        expect(mqtt.subscribe).toHaveBeenCalledWith(
            `${DEFAULT_TOPIC}/commands`,
            expect.any(Function)
        );
        await adapter.dispose();
    });

    it('publishes initial state (off, intensity 0)', async () => {
        const { adapter, mqtt } = makeAdapter();
        await adapter.init();
        const stateCall = mqtt.publish.mock.calls.find(
            ([topic]) => topic === `${DEFAULT_TOPIC}/state`
        );
        expect(stateCall).toBeDefined();
        const state = JSON.parse(stateCall[1]);
        expect(state.on).toBe(false);
        expect(state.intensity).toBe(0);
        await adapter.dispose();
    });

    it('zeros all DMX channels on init', async () => {
        const { adapter, universe } = makeAdapter({ config: { address: 10 } });
        await adapter.init();
        // fogger-1ch has 1 channel at address 10
        expect(universe.setChannel).toHaveBeenCalledWith(10, 0);
        await adapter.dispose();
    });
});

// ── burst command ─────────────────────────────────────────────────────────

describe('DmxEffectAdapter — burst command', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('sets DMX channel to non-zero on burst', async () => {
        const { adapter, mqtt, universe } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'burst', duration_ms: 1000, intensity: 100 });
        // Channel 1 should be 255 (100% of 255)
        expect(universe.setChannel).toHaveBeenCalledWith(1, 255);
    });

    it('sets DMX channel proportional to intensity', async () => {
        const { adapter, mqtt, universe } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'burst', duration_ms: 1000, intensity: 50 });
        // 50% of 255 = 128 (rounded)
        expect(universe.setChannel).toHaveBeenCalledWith(1, 128);
    });

    it('state is on=true during burst', async () => {
        const { adapter, mqtt } = makeAdapter();
        await adapter.init();
        mqtt.publish.mockClear();
        await sendCmd(mqtt, { command: 'burst', duration_ms: 1000, intensity: 80 });

        const stateCall = mqtt.publish.mock.calls.find(
            ([topic]) => topic === `${DEFAULT_TOPIC}/state`
        );
        const state = JSON.parse(stateCall[1]);
        expect(state.on).toBe(true);
        expect(state.intensity).toBe(80);
        expect(state.expires_at).not.toBeNull();
    });

    it('auto-stops (zeros channel) after duration_ms', async () => {
        const { adapter, mqtt, universe } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'burst', duration_ms: 1000 });

        // Channel should be set to non-zero right now
        universe.setChannel.mockClear();

        jest.advanceTimersByTime(1000);
        await Promise.resolve(); // flush the timer callback's setImmediate if any

        // Channel should now be zeroed
        expect(universe.setChannel).toHaveBeenCalledWith(1, 0);
    });

    it('publishes burst-ended event after duration expires', async () => {
        const { adapter, mqtt } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'burst', duration_ms: 500 });
        mqtt.publish.mockClear();

        jest.advanceTimersByTime(500);
        await Promise.resolve();

        const eventCalls = mqtt.publish.mock.calls.filter(
            ([topic]) => topic === `${DEFAULT_TOPIC}/events`
        );
        const endEvent = eventCalls.map(([, body]) => JSON.parse(body)).find(e => e.event === 'burst-ended');
        expect(endEvent).toBeDefined();
    });

    it('rejects burst when duration_ms exceeds max_run_ms', async () => {
        const { adapter, mqtt, universe } = makeAdapter({ config: { max_run_ms: 2000 } });
        await adapter.init();
        universe.setChannel.mockClear();
        await sendCmd(mqtt, { command: 'burst', duration_ms: 5000 });

        // No channel should have been set to a non-zero value (burst was rejected)
        expect(universe.setChannel).not.toHaveBeenCalled();
        // Warning should be published
        const warnCalls = mqtt.publish.mock.calls.filter(
            ([topic]) => topic === `${DEFAULT_TOPIC}/warnings`
        );
        expect(warnCalls.length).toBeGreaterThan(0);
        const warning = JSON.parse(warnCalls[0][1]);
        expect(warning.code).toBe('EFFECT_DURATION_CAPPED');
    });

    it('rejects burst with missing duration_ms', async () => {
        const { adapter, mqtt, universe } = makeAdapter();
        await adapter.init();
        universe.setChannel.mockClear();
        await sendCmd(mqtt, { command: 'burst' });
        const warnCalls = mqtt.publish.mock.calls.filter(
            ([topic]) => topic === `${DEFAULT_TOPIC}/warnings`
        );
        expect(warnCalls.length).toBeGreaterThan(0);
    });

    it('pulse is an alias for burst', async () => {
        const { adapter, mqtt, universe } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'pulse', duration_ms: 200, intensity: 100 });
        expect(universe.setChannel).toHaveBeenCalledWith(1, 255);
    });

    it('cancels existing timer when new burst arrives', async () => {
        const { adapter, mqtt, universe } = makeAdapter({ config: { max_run_ms: 5000 } });
        await adapter.init();
        await sendCmd(mqtt, { command: 'burst', duration_ms: 3000, intensity: 80 });
        // Start a second burst immediately — first timer should be discarded
        await sendCmd(mqtt, { command: 'burst', duration_ms: 1000, intensity: 100 });

        universe.setChannel.mockClear();
        jest.advanceTimersByTime(3000);
        await Promise.resolve();

        // After 3000ms: the second timer fired at +1000ms (exactly 1 zeroing call).
        // If the first (cancelled) timer had also fired at +3000ms, there would be 2 calls.
        expect(universe.setChannel.mock.calls.filter(([, v]) => v === 0).length).toBe(1);
    });
});

// ── stop command ──────────────────────────────────────────────────────────

describe('DmxEffectAdapter — stop command', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('zeros DMX channel immediately', async () => {
        const { adapter, mqtt, universe } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'burst', duration_ms: 3000, intensity: 100 });
        universe.setChannel.mockClear();

        await sendCmd(mqtt, { command: 'stop' });
        expect(universe.setChannel).toHaveBeenCalledWith(1, 0);
    });

    it('cancels the running burst timer on stop', async () => {
        const { adapter, mqtt, universe } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'burst', duration_ms: 3000, intensity: 100 });

        await sendCmd(mqtt, { command: 'stop' });
        universe.setChannel.mockClear();

        // Advance past original burst duration — timer should not fire again
        jest.advanceTimersByTime(3000);
        await Promise.resolve();

        expect(universe.setChannel).not.toHaveBeenCalled();
    });

    it('state is on=false after stop', async () => {
        const { adapter, mqtt } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'burst', duration_ms: 3000 });
        mqtt.publish.mockClear();

        await sendCmd(mqtt, { command: 'stop' });
        const stateCall = mqtt.publish.mock.calls.find(([t]) => t === `${DEFAULT_TOPIC}/state`);
        const state = JSON.parse(stateCall[1]);
        expect(state.on).toBe(false);
        expect(state.intensity).toBe(0);
        expect(state.expires_at).toBeNull();
    });
});

// ── setIntensity command ──────────────────────────────────────────────────

describe('DmxEffectAdapter — setIntensity command', () => {
    it('writes proportional DMX value without starting a timer', async () => {
        jest.useFakeTimers();
        const { adapter, mqtt, universe } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'setIntensity', intensity: 75 });

        // 75% of 255 = 191 (rounded)
        expect(universe.setChannel).toHaveBeenCalledWith(1, 191);
        jest.useRealTimers();
    });

    it('clamps intensity above 100 to 100', async () => {
        const { adapter, mqtt, universe } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'setIntensity', intensity: 150 });
        expect(universe.setChannel).toHaveBeenCalledWith(1, 255);
    });

    it('setIntensity to 0 zeroes the channel', async () => {
        const { adapter, mqtt, universe } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'setIntensity', intensity: 0 });
        expect(universe.setChannel).toHaveBeenCalledWith(1, 0);
    });
});

// ── dispose() ────────────────────────────────────────────────────────────

describe('DmxEffectAdapter — dispose()', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('zeros all channels on dispose even if burst is running', async () => {
        const { adapter, mqtt, universe } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'burst', duration_ms: 3000, intensity: 100 });
        universe.setChannel.mockClear();

        await adapter.dispose();
        expect(universe.setChannel).toHaveBeenCalledWith(1, 0);
    });

    it('cancels the burst timer on dispose', async () => {
        const { adapter, mqtt, universe } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'burst', duration_ms: 3000, intensity: 100 });

        await adapter.dispose();
        universe.setChannel.mockClear();

        // Timer should not fire after dispose
        jest.advanceTimersByTime(3000);
        await Promise.resolve();
        expect(universe.setChannel).not.toHaveBeenCalled();
    });

    it('throws on operations after dispose', async () => {
        const { adapter } = makeAdapter();
        await adapter.init();
        await adapter.dispose();
        await expect(adapter.dispose()).rejects.toThrow(/after dispose/i);
    });
});

// ── strobe-2ch profile ────────────────────────────────────────────────────

describe('DmxEffectAdapter — strobe-2ch profile', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    function makeStrobe(cfgOverrides = {}) {
        return makeAdapter({
            config: { fixture: 'strobe-2ch', address: 1, strobe_rate: 200, ...cfgOverrides },
        });
    }

    it('sets strobe channel to configured strobe_rate on burst', async () => {
        const { adapter, mqtt, universe } = makeStrobe();
        await adapter.init();
        await sendCmd(mqtt, { command: 'burst', duration_ms: 1000, intensity: 100 });
        // strobe-2ch: CH1=strobe (slot index 0), CH2=dimmer (slot index 1)
        expect(universe.setChannel).toHaveBeenCalledWith(1, 200); // strobe rate
        expect(universe.setChannel).toHaveBeenCalledWith(2, 255); // dimmer at 100%
    });

    it('zeros strobe channel when stopped', async () => {
        const { adapter, mqtt, universe } = makeStrobe();
        await adapter.init();
        await sendCmd(mqtt, { command: 'burst', duration_ms: 500, intensity: 100 });
        universe.setChannel.mockClear();

        jest.advanceTimersByTime(500);
        await Promise.resolve();
        expect(universe.setChannel).toHaveBeenCalledWith(1, 0); // strobe zeroed
        expect(universe.setChannel).toHaveBeenCalledWith(2, 0); // dimmer zeroed
    });
});

// ── fogger-2ch profile (fan_speed) ───────────────────────────────────────

describe('DmxEffectAdapter — fogger-2ch profile', () => {
    it('sets fan channel to configured fan_speed on burst', async () => {
        const { adapter, mqtt, universe } = makeAdapter({
            config: { fixture: 'fogger-2ch', address: 1, fan_speed: 180 },
        });
        await adapter.init();
        await sendCmd(mqtt, { command: 'burst', duration_ms: 500, intensity: 100 });
        expect(universe.setChannel).toHaveBeenCalledWith(1, 255); // dimmer
        expect(universe.setChannel).toHaveBeenCalledWith(2, 180); // fan speed
    });
});

// ── Unknown command ───────────────────────────────────────────────────────

describe('DmxEffectAdapter — unknown commands', () => {
    it('publishes a warning for unknown commands', async () => {
        const { adapter, mqtt } = makeAdapter();
        await adapter.init();
        await sendCmd(mqtt, { command: 'on' });
        const warnCalls = mqtt.publish.mock.calls.filter(
            ([topic]) => topic === `${DEFAULT_TOPIC}/warnings`
        );
        expect(warnCalls.length).toBeGreaterThan(0);
        const warning = JSON.parse(warnCalls[0][1]);
        expect(warning.code).toBe('EFFECT_CMD_UNKNOWN');
    });
});
