'use strict';

const { NodeCommandHandler } = require('../../src/bridge/node-command-handler');
const { NodeRegistry } = require('../../src/bridge/node-registry');

function makeMqtt() {
    const published = [];
    const subs = {};
    return {
        _published: published,
        _subs: subs,
        publish(topic, payload, opts) { published.push({ topic, payload, opts }); },
        subscribe(topic, fn) { subs[topic] = fn; },
        deliver(topic, payload) { subs[topic]?.(topic, payload); },
    };
}

function makeDriver({ connected = true, setOk = true, unsupported = false } = {}) {
    const calls = [];
    const node = {
        commandClasses: unsupported ? {} : {
            'Binary Switch': {
                set: async (value) => {
                    calls.push(value);
                    if (!setOk) throw new Error('transport');
                },
            },
        },
    };
    return {
        _calls: calls,
        connected,
        controller: connected ? { nodes: new Map([[3, node]]) } : null,
    };
}

const nodeConfig = {
    'relay-alpha': {
        label: 'relay-alpha',
        radio: 'zwave',
        type: 'relay',
        node_id: 3,
        base_topic: 'paradox/test/zwave/alpha',
    },
    'contact-beta': {
        label: 'contact-beta',
        radio: 'zwave',
        type: 'contact',
        node_id: 4,
        base_topic: 'paradox/test/zwave/beta',
    },
};

describe('NodeCommandHandler: setRelay', () => {
    test('routes on command to Binary Switch.set(true) and echoes state', async () => {
        const mqtt = makeMqtt();
        const registry = new NodeRegistry(nodeConfig);
        const driver = makeDriver();
        const events = { publishNodeState: jest.fn() };
        new NodeCommandHandler({ mqttClient: mqtt, nodeRegistry: registry, zwaveDriver: driver, zwaveEvents: events });

        mqtt.deliver('paradox/test/zwave/alpha/commands', { command: 'setRelay', state: 'on' });
        await new Promise((r) => setImmediate(r));

        expect(driver._calls).toEqual([true]);
        const entry = registry.getByLabel('relay-alpha');
        expect(entry.signals.relay.value).toBe('on');
        expect(events.publishNodeState).toHaveBeenCalled();
    });

    test('rejects setRelay on contact-type node with COMMAND_UNSUPPORTED warning', async () => {
        const mqtt = makeMqtt();
        const registry = new NodeRegistry(nodeConfig);
        const driver = makeDriver();
        new NodeCommandHandler({ mqttClient: mqtt, nodeRegistry: registry, zwaveDriver: driver });

        mqtt.deliver('paradox/test/zwave/beta/commands', { command: 'setRelay', state: 'on' });
        await new Promise((r) => setImmediate(r));

        const warn = mqtt._published.find((p) => p.payload?.code === 'COMMAND_UNSUPPORTED');
        expect(warn).toBeTruthy();
        expect(warn.topic).toBe('paradox/test/zwave/beta/warnings');
    });

    test('emits BAD_COMMAND when state is invalid', async () => {
        const mqtt = makeMqtt();
        const registry = new NodeRegistry(nodeConfig);
        const driver = makeDriver();
        new NodeCommandHandler({ mqttClient: mqtt, nodeRegistry: registry, zwaveDriver: driver });

        mqtt.deliver('paradox/test/zwave/alpha/commands', { command: 'setRelay', state: 'maybe' });
        await new Promise((r) => setImmediate(r));

        const warn = mqtt._published.find((p) => p.payload?.code === 'BAD_COMMAND');
        expect(warn).toBeTruthy();
    });

    test('emits UNKNOWN_COMMAND for unknown command', async () => {
        const mqtt = makeMqtt();
        const registry = new NodeRegistry(nodeConfig);
        new NodeCommandHandler({ mqttClient: mqtt, nodeRegistry: registry, zwaveDriver: makeDriver() });

        mqtt.deliver('paradox/test/zwave/alpha/commands', { command: 'teleport' });
        await new Promise((r) => setImmediate(r));
        const warn = mqtt._published.find((p) => p.payload?.code === 'UNKNOWN_COMMAND');
        expect(warn).toBeTruthy();
    });
});

describe('NodeCommandHandler: pulseRelay', () => {
    test('toggles on then off', async () => {
        jest.useFakeTimers();
        try {
            const mqtt = makeMqtt();
            const registry = new NodeRegistry(nodeConfig);
            const driver = makeDriver();
            const events = { publishNodeState: jest.fn() };
            new NodeCommandHandler({ mqttClient: mqtt, nodeRegistry: registry, zwaveDriver: driver, zwaveEvents: events });

            mqtt.deliver('paradox/test/zwave/alpha/commands', { command: 'pulseRelay', ms: 100 });
            // Let first set() resolve
            await Promise.resolve();
            await Promise.resolve();
            jest.advanceTimersByTime(100);
            // Let second set() resolve
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(driver._calls).toEqual([true, false]);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('BridgeCommandHandler: Phase 2 extensions', () => {
    const { BridgeCommandHandler } = require('../../src/bridge/command-handler');

    function setup(overrides = {}) {
        const published = [];
        const subs = {};
        const warnings = [];
        const mqtt = {
            publish(topic, payload, opts) { published.push({ topic, payload, opts }); },
            subscribe(topic, fn) { subs[topic] = fn; },
        };
        const registry = new NodeRegistry(nodeConfig);
        const handler = new BridgeCommandHandler({
            mqttClient: mqtt,
            baseTopic: 'paradox/test',
            getStatus: () => ({ state: 'ok' }),
            publishWarning: (w) => warnings.push(w),
            nodeRegistry: registry,
            ...overrides,
        });
        return {
            handler, published, warnings, registry,
            deliver: (payload) => subs['paradox/test/pzb/commands']?.('paradox/test/pzb/commands', payload),
        };
    }

    test('startInclusion delegates to inclusion FSM', async () => {
        const calls = [];
        const inclusion = {
            startInclusion: async (opts) => { calls.push(['start', opts]); },
            stopInclusion: async () => { calls.push(['stop']); },
            startExclusion: async () => { calls.push(['startX']); },
            stopExclusion: async () => { calls.push(['stopX']); },
        };
        const { deliver } = setup({ zwaveInclusion: inclusion });
        deliver({ command: 'startInclusion', timeout_s: 30 });
        await new Promise((r) => setImmediate(r));
        expect(calls[0]).toEqual(['start', { timeoutMs: 30_000 }]);
    });

    test('startInclusion without inclusion module warns ZWAVE_DISABLED', async () => {
        const { warnings, deliver } = setup();
        deliver({ command: 'startInclusion' });
        await new Promise((r) => setImmediate(r));
        expect(warnings[0].code).toBe('ZWAVE_DISABLED');
    });

    test('refreshNode by label calls refreshInfo on resolved node', async () => {
        const refreshed = [];
        const node = { refreshInfo: async () => refreshed.push(true) };
        const driver = { connected: true, controller: { nodes: new Map([[3, node]]) } };
        const { deliver } = setup({ zwaveDriver: driver });
        deliver({ command: 'refreshNode', label: 'relay-alpha' });
        await new Promise((r) => setImmediate(r));
        expect(refreshed).toEqual([true]);
    });

    test('removeFailedNode calls controller.removeFailedNode', async () => {
        const removed = [];
        const driver = {
            connected: true,
            controller: {
                nodes: new Map([[3, {}]]),
                removeFailedNode: async (id) => removed.push(id),
            },
        };
        const { deliver } = setup({ zwaveDriver: driver });
        deliver({ command: 'removeFailedNode', node_id: 3 });
        await new Promise((r) => setImmediate(r));
        expect(removed).toEqual([3]);
    });
});
