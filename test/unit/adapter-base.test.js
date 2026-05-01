/**
 * test/unit/adapter-base.test.js — Unit tests for AdapterBase contract
 */

const AdapterBase = require('../../src/adapter-base');

describe('AdapterBase', () => {
    describe('constructor', () => {
        it('should construct with valid options', () => {
            const mockMqtt = { publish: jest.fn() };
            const mockLogger = { warn: jest.fn(), error: jest.fn() };

            const adapter = new AdapterBase({
                name: 'TestAdapter',
                config: { topic: 'test/zone' },
                mqttClient: mockMqtt,
                logger: mockLogger,
            });

            expect(adapter.name).toBe('TestAdapter');
            expect(adapter.config.topic).toBe('test/zone');
            expect(adapter._disposed).toBe(false);
        });

        it('should throw if config.topic is missing', () => {
            const mockMqtt = { publish: jest.fn() };
            const mockLogger = { warn: jest.fn() };

            expect(() => {
                new AdapterBase({
                    name: 'TestAdapter',
                    config: {},
                    mqttClient: mockMqtt,
                    logger: mockLogger,
                });
            }).toThrow(/config.topic is required/);
        });

        it('should throw if mqttClient is missing', () => {
            expect(() => {
                new AdapterBase({
                    name: 'TestAdapter',
                    config: { topic: 'test/zone' },
                    mqttClient: null,
                    logger: {},
                });
            }).toThrow(/mqttClient is required/);
        });

        it('should throw if logger is missing', () => {
            expect(() => {
                new AdapterBase({
                    name: 'TestAdapter',
                    config: { topic: 'test/zone' },
                    mqttClient: {},
                    logger: null,
                });
            }).toThrow(/logger is required/);
        });
    });

    describe('publishWarning', () => {
        it('should publish warning to {topic}/warnings', () => {
            const mockMqtt = { publish: jest.fn().mockResolvedValue() };
            const mockLogger = { warn: jest.fn(), error: jest.fn() };

            const adapter = new AdapterBase({
                name: 'TestAdapter',
                config: { topic: 'test/zone' },
                mqttClient: mockMqtt,
                logger: mockLogger,
            });

            adapter.publishWarning('TEST_ERROR', 'Test error message', { detail: 'value' });

            expect(mockMqtt.publish).toHaveBeenCalled();
            const call = mockMqtt.publish.mock.calls[0];
            expect(call[0]).toBe('test/zone/warnings');
            const payload = JSON.parse(call[1]);
            expect(payload.code).toBe('TEST_ERROR');
            expect(payload.message).toBe('Test error message');
            expect(payload.detail).toBe('value');
        });

        it('should silently ignore warning if disposed', () => {
            const mockMqtt = { publish: jest.fn() };
            const mockLogger = { warn: jest.fn(), error: jest.fn() };

            const adapter = new AdapterBase({
                name: 'TestAdapter',
                config: { topic: 'test/zone' },
                mqttClient: mockMqtt,
                logger: mockLogger,
            });

            adapter._markDisposed();
            adapter.publishWarning('TEST', 'Should be ignored');

            expect(mockMqtt.publish).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalled();
        });
    });

    describe('publishState', () => {
        it('should publish state to {topic}/state with retain=true', () => {
            const mockMqtt = { publish: jest.fn().mockResolvedValue() };
            const mockLogger = { warn: jest.fn(), error: jest.fn() };

            const adapter = new AdapterBase({
                name: 'TestAdapter',
                config: { topic: 'test/zone' },
                mqttClient: mockMqtt,
                logger: mockLogger,
            });

            adapter.publishState({ status: 'online', brightness: 100 });

            expect(mockMqtt.publish).toHaveBeenCalled();
            const call = mockMqtt.publish.mock.calls[0];
            expect(call[0]).toBe('test/zone/state');
            expect(call[2].retain).toBe(true);
        });
    });

    describe('publishEvent', () => {
        it('should publish event to {topic}/events with retain=false', () => {
            const mockMqtt = { publish: jest.fn().mockResolvedValue() };
            const mockLogger = { warn: jest.fn(), error: jest.fn() };

            const adapter = new AdapterBase({
                name: 'TestAdapter',
                config: { topic: 'test/zone' },
                mqttClient: mockMqtt,
                logger: mockLogger,
            });

            adapter.publishEvent('scene-activated', { scene: 'warm' });

            expect(mockMqtt.publish).toHaveBeenCalled();
            const call = mockMqtt.publish.mock.calls[0];
            expect(call[0]).toBe('test/zone/events');
            expect(call[2].retain).toBe(false);
        });
    });

    describe('_assertNotDisposed', () => {
        it('should throw if adapter is disposed', () => {
            const mockMqtt = { publish: jest.fn() };
            const mockLogger = { warn: jest.fn() };

            const adapter = new AdapterBase({
                name: 'TestAdapter',
                config: { topic: 'test/zone' },
                mqttClient: mockMqtt,
                logger: mockLogger,
            });

            adapter._markDisposed();

            expect(() => {
                adapter._assertNotDisposed();
            }).toThrow(/Operation called after dispose/);
        });
    });
});
