/**
 * test/unit/inputs/aggregator.test.js — Unit tests for InputsAdapter
 */

'use strict';

const InputsAdapter = require('../../../src/inputs/aggregator');

describe('InputsAdapter', () => {
    let mockMqtt;
    let mockLogger;
    let adapter;

    const config = {
        topic: 'paradox/houdini/inputs',
        filter_duplicates_ms: 100,
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockMqtt = {
            publish: jest.fn().mockResolvedValue(),
            subscribe: jest.fn((topic, callback) => {
                if (!mockMqtt._subs) mockMqtt._subs = {};
                mockMqtt._subs[topic] = callback;
            }),
            unsubscribe: jest.fn().mockResolvedValue(),
        };
        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };

        adapter = new InputsAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
    });

    afterEach(() => {
        if (adapter && !adapter._disposed) {
            adapter._disposed = true;
        }
    });

    describe('constructor', () => {
        it('should set filterMs from config', () => {
            expect(adapter.filterMs).toBe(100);
        });

        it('should default filterMs to 100 if not configured', () => {
            const a = new InputsAdapter({ config: { topic: 'x/y/inputs' }, mqttClient: mockMqtt, logger: mockLogger });
            expect(a.filterMs).toBe(100);
            a._disposed = true;
        });
    });

    describe('init', () => {
        it('should subscribe to each node event topic', async () => {
            const nodes = [
                { label: 'door-sensor', base_topic: 'paradox/nodes/door-sensor', type: 'contact' },
                { label: 'motion-1', base_topic: 'paradox/nodes/motion-1', type: 'motion' },
            ];
            await adapter.init(nodes);

            expect(mockMqtt.subscribe).toHaveBeenCalledWith(
                'paradox/nodes/door-sensor/events', expect.any(Function)
            );
            expect(mockMqtt.subscribe).toHaveBeenCalledWith(
                'paradox/nodes/motion-1/events', expect.any(Function)
            );
        });

        it('should seed input state to unknown for each node', async () => {
            const nodes = [{ label: 'door', base_topic: 'paradox/nodes/door', type: 'contact' }];
            await adapter.init(nodes);
            const state = adapter._inputs.get('door');
            expect(state.state).toBe('unknown');
        });

        it('should publish state after init', async () => {
            await adapter.init([]);
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/state'),
                expect.any(String),
                expect.any(Object)
            );
        });
    });

    describe('handleStateUpdate', () => {
        it('should update state for a known node', async () => {
            const nodes = [{ label: 'door', base_topic: 'paradox/nodes/door', type: 'contact' }];
            await adapter.init(nodes);

            adapter.handleStateUpdate('door', { state: 'closed', value: 0 });
            expect(adapter._inputs.get('door').state).toBe('closed');
        });

        it('should silently ignore unknown node labels', async () => {
            await adapter.init([]);
            expect(() => adapter.handleStateUpdate('unknown-label', { state: 'open' })).not.toThrow();
        });
    });

    describe('event handling (via MQTT subscription)', () => {
        it('should forward node events to zone events topic', async () => {
            const nodes = [{ label: 'door', base_topic: 'paradox/nodes/door', type: 'contact' }];
            await adapter.init(nodes);

            const callback = mockMqtt._subs['paradox/nodes/door/events'];
            callback(JSON.stringify({ event: 'open', value: 1 }));

            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/events'),
                expect.stringContaining('input-changed'),
                expect.any(Object)
            );
        });

        it('should suppress duplicate events within filter window', async () => {
            const nodes = [{ label: 'door', base_topic: 'paradox/nodes/door', type: 'contact' }];
            await adapter.init(nodes);
            jest.clearAllMocks(); // clear init calls

            const callback = mockMqtt._subs['paradox/nodes/door/events'];
            const msg = JSON.stringify({ event: 'open', value: 1 });
            callback(msg);
            callback(msg); // duplicate within 100ms

            // Only one event published (the second is suppressed)
            const eventCalls = mockMqtt.publish.mock.calls.filter((c) => c[0].includes('/events'));
            expect(eventCalls.length).toBe(1);
        });

        it('should silently discard malformed JSON', async () => {
            const nodes = [{ label: 'door', base_topic: 'paradox/nodes/door', type: 'contact' }];
            await adapter.init(nodes);
            const callback = mockMqtt._subs['paradox/nodes/door/events'];
            expect(() => callback('not-json')).not.toThrow();
        });
    });

    describe('executeCommand', () => {
        it('should re-publish state on getState command', async () => {
            await adapter.init([]);
            jest.clearAllMocks();
            await adapter.executeCommand({ command: 'getState' });
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/state'),
                expect.any(String),
                expect.any(Object)
            );
        });

        it('should warn on write commands (inputs are read-only)', async () => {
            await adapter.executeCommand({ command: 'setInput' });
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('INPUTS_CMD_UNKNOWN'),
                expect.any(Object)
            );
        });

        it('should warn on invalid payload', async () => {
            await adapter.executeCommand(null);
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('INPUTS_CMD_INVALID'),
                expect.any(Object)
            );
        });
    });

    describe('dispose', () => {
        it('should unsubscribe all node event topics', async () => {
            const nodes = [
                { label: 'door', base_topic: 'paradox/nodes/door', type: 'contact' },
                { label: 'motion', base_topic: 'paradox/nodes/motion', type: 'motion' },
            ];
            await adapter.init(nodes);
            await adapter.dispose();
            expect(mockMqtt.unsubscribe).toHaveBeenCalledWith('paradox/nodes/door/events');
            expect(mockMqtt.unsubscribe).toHaveBeenCalledWith('paradox/nodes/motion/events');
        });

        it('should throw on double-dispose', async () => {
            await adapter.init([]);
            await adapter.dispose();
            await expect(adapter.dispose()).rejects.toThrow('dispose');
        });
    });
});
