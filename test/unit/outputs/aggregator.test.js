/**
 * test/unit/outputs/aggregator.test.js — Unit tests for OutputsAdapter
 */

'use strict';

const OutputsAdapter = require('../../../src/outputs/aggregator');

describe('OutputsAdapter', () => {
    let mockMqtt;
    let mockLogger;
    let adapter;

    const config = {
        topic: 'paradox/houdini/outputs',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockMqtt = {
            publish: jest.fn().mockResolvedValue(),
            subscribe: jest.fn((topic, callback) => {
                mockMqtt._commandCallback = callback;
            }),
            unsubscribe: jest.fn().mockResolvedValue(),
        };
        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        adapter = new OutputsAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
    });

    afterEach(() => {
        if (adapter && !adapter._disposed) {
            adapter._disposed = true;
        }
    });

    describe('constructor', () => {
        it('should construct with valid config', () => {
            expect(adapter._outputs).toBeDefined();
            expect(adapter._handlers).toBeDefined();
        });
    });

    describe('init', () => {
        it('should register output handlers', async () => {
            const relayHandler = jest.fn().mockResolvedValue();
            await adapter.init([{ id: 'relay-1', type: 'relay', handler: relayHandler }]);

            expect(adapter._outputs.has('relay-1')).toBe(true);
            expect(adapter._handlers.has('relay-1')).toBe(true);
        });

        it('should subscribe to commands topic', async () => {
            await adapter.init([]);
            expect(mockMqtt.subscribe).toHaveBeenCalledWith(
                'paradox/houdini/outputs/commands',
                expect.any(Function)
            );
        });

        it('should publish initial state', async () => {
            await adapter.init([]);
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/state'),
                expect.any(String),
                expect.any(Object)
            );
        });
    });

    describe('executeCommand — setOutput', () => {
        let relayHandler;

        beforeEach(async () => {
            relayHandler = jest.fn().mockResolvedValue();
            await adapter.init([{ id: 'door-lock', type: 'relay', handler: relayHandler }]);
            jest.clearAllMocks();
        });

        it('should call the registered handler for setOutput', async () => {
            await adapter.executeCommand({ command: 'setOutput', outputId: 'door-lock', on: true });
            expect(relayHandler).toHaveBeenCalledWith(expect.objectContaining({ on: true }));
        });

        it('should publish output-set event', async () => {
            await adapter.executeCommand({ command: 'setOutput', outputId: 'door-lock', on: true });
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/events'),
                expect.stringContaining('output-set'),
                expect.any(Object)
            );
        });

        it('should warn if outputId is missing', async () => {
            await adapter.executeCommand({ command: 'setOutput' });
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('OUTPUTS_MISSING_ID'),
                expect.any(Object)
            );
        });

        it('should warn if outputId is not registered', async () => {
            await adapter.executeCommand({ command: 'setOutput', outputId: 'unknown-relay', on: true });
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('OUTPUTS_UNKNOWN_ID'),
                expect.any(Object)
            );
        });

        it('should publish warning if handler throws', async () => {
            relayHandler.mockRejectedValueOnce(new Error('hardware fault'));
            await adapter.executeCommand({ command: 'setOutput', outputId: 'door-lock', on: true });
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('OUTPUTS_COMMAND_FAILED'),
                expect.any(Object)
            );
        });
    });

    describe('executeCommand — pulse', () => {
        it('should call handler twice (on then off)', async () => {
            const relayHandler = jest.fn().mockResolvedValue();
            await adapter.init([{ id: 'bell', type: 'relay', handler: relayHandler }]);
            jest.clearAllMocks();

            // Use a very short duration so test completes quickly without fake timers
            await adapter.executeCommand({ command: 'pulse', outputId: 'bell', duration_ms: 1 });

            expect(relayHandler).toHaveBeenCalledTimes(2);
        }, 10000);

        it('should warn if outputId missing on pulse', async () => {
            await adapter.init([]);
            jest.clearAllMocks();
            await adapter.executeCommand({ command: 'pulse' });
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('OUTPUTS_MISSING_ID'),
                expect.any(Object)
            );
        });
    });

    describe('executeCommand — unknown action', () => {
        it('should warn on unknown action', async () => {
            await adapter.init([]);
            jest.clearAllMocks();
            await adapter.executeCommand({ command: 'explode' });
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('OUTPUTS_CMD_UNKNOWN'),
                expect.any(Object)
            );
        });

        it('should warn on invalid payload', async () => {
            await adapter.init([]);
            jest.clearAllMocks();
            await adapter.executeCommand('string-payload');
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('OUTPUTS_CMD_INVALID'),
                expect.any(Object)
            );
        });
    });

    describe('handleStateUpdate', () => {
        it('should update output state entry', async () => {
            await adapter.init([{ id: 'relay-1', type: 'relay', handler: jest.fn().mockResolvedValue() }]);
            adapter.handleStateUpdate('relay-1', { state: 'on' });
            expect(adapter._outputs.get('relay-1').state).toBe('on');
        });

        it('should silently ignore unknown outputId', async () => {
            await adapter.init([]);
            expect(() => adapter.handleStateUpdate('ghost-relay', { state: 'on' })).not.toThrow();
        });
    });

    describe('dispose', () => {
        it('should unsubscribe from commands topic', async () => {
            await adapter.init([]);
            await adapter.dispose();
            expect(mockMqtt.unsubscribe).toHaveBeenCalledWith('paradox/houdini/outputs/commands');
        });

        it('should mark adapter as disposed', async () => {
            await adapter.init([]);
            await adapter.dispose();
            expect(adapter._disposed).toBe(true);
        });

        it('should throw on double-dispose', async () => {
            await adapter.init([]);
            await adapter.dispose();
            await expect(adapter.dispose()).rejects.toThrow('dispose');
        });
    });

    describe('MQTT command routing', () => {
        it('should route commands received via MQTT', async () => {
            const handler = jest.fn().mockResolvedValue();
            await adapter.init([{ id: 'relay-1', type: 'relay', handler }]);
            jest.clearAllMocks();

            // Simulate MQTT command arrival
            mockMqtt._commandCallback(JSON.stringify({ command: 'setOutput', outputId: 'relay-1', on: true }));

            // Allow async handler to complete
            await new Promise((r) => setImmediate(r));

            expect(handler).toHaveBeenCalled();
        });

        it('should handle malformed JSON command gracefully', async () => {
            await adapter.init([]);
            expect(() => mockMqtt._commandCallback('not-json')).not.toThrow();
        });
    });
});
