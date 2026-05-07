'use strict';

const { BridgeCommandHandler } = require('../../src/bridge/command-handler');

function makeSetup(overrides = {}) {
    const published = [];
    const subscriptions = {};
    const warnings = [];

    const mqttClient = {
        publish(topic, payload, opts) { published.push({ topic, payload, opts }); },
        subscribe(topic, fn) { subscriptions[topic] = fn; },
    };

    const handler = new BridgeCommandHandler({
        mqttClient,
        baseTopic: 'paradox/test',
        getStatus: () => ({ state: 'ok', timestamp: 'T' }),
        publishWarning: (w) => warnings.push(w),
        ...overrides,
    });

    // Helper: deliver a command payload to the subscribed topic
    function deliver(payload) {
        const topic = 'paradox/test/pxb/commands';
        subscriptions[topic]?.(topic, payload);
    }

    return { handler, published, warnings, deliver };
}

describe('BridgeCommandHandler: getNetworkStatus', () => {
    test('publishes state to pxb/state with retain:true', () => {
        const { published, deliver } = makeSetup();
        deliver({ command: 'getNetworkStatus' });
        expect(published).toHaveLength(1);
        const { topic, payload, opts } = published[0];
        expect(topic).toBe('paradox/test/pxb/state');
        expect(payload.state).toBe('ok');
        expect(opts.retain).toBe(true);
    });
});

describe('BridgeCommandHandler: unknown command', () => {
    test('publishes warning with UNKNOWN_BRIDGE_COMMAND code', () => {
        const { warnings, deliver } = makeSetup();
        deliver({ command: 'teleport' });
        expect(warnings).toHaveLength(1);
        expect(warnings[0].code).toBe('UNKNOWN_BRIDGE_COMMAND');
        expect(warnings[0].context.command).toBe('teleport');
    });
    test('non-object payload is silently ignored', () => {
        const { warnings, published, deliver } = makeSetup();
        deliver('not-an-object');
        expect(warnings).toHaveLength(0);
        expect(published).toHaveLength(0);
    });
    test('missing command field is silently ignored', () => {
        const { warnings, published, deliver } = makeSetup();
        deliver({ foo: 'bar' });
        expect(warnings).toHaveLength(0);
        expect(published).toHaveLength(0);
    });
});
