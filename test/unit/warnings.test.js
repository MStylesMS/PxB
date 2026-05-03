'use strict';

const { publishBridgeWarning } = require('../../src/bridge/warnings');

function makeMockMqtt() {
    const published = [];
    return {
        published,
        publish(topic, payload, opts) {
            published.push({ topic, payload, opts });
        },
    };
}

describe('publishBridgeWarning', () => {
    test('publishes to {base_topic}/pxb/warnings with correct shape', () => {
        const mock = makeMockMqtt();
        publishBridgeWarning(mock, 'paradox/test', {
            severity: 'warn',
            code: 'ZWAVE_DISCONNECTED',
            message: 'port closed',
            context: { port: '/dev/ttyUSB0' },
        });

        expect(mock.published).toHaveLength(1);
        const { topic, payload, opts } = mock.published[0];
        expect(topic).toBe('paradox/test/pxb/warnings');
        expect(opts.retain).toBe(false);
        expect(payload).toMatchObject({
            severity: 'warn',
            code: 'ZWAVE_DISCONNECTED',
            message: 'port closed',
            context: { port: '/dev/ttyUSB0' },
        });
        expect(typeof payload.timestamp).toBe('string');
    });

    test('defaults severity to warn and context to {}', () => {
        const mock = makeMockMqtt();
        publishBridgeWarning(mock, 'paradox/test', { code: 'FOO', message: 'bar' });
        const { payload } = mock.published[0];
        expect(payload.severity).toBe('warn');
        expect(payload.context).toEqual({});
    });
});
