/**
 * test/unit/lights/hue.test.js — Unit tests for HueAdapter
 */

const HueAdapter = require('../../../src/lights/hue');

describe('HueAdapter', () => {
    let mockMqtt;
    let mockLogger;
    let adapter;

    beforeEach(() => {
        mockMqtt = {
            publish: jest.fn().mockResolvedValue(),
            subscribe: jest.fn((topic, callback) => {
                // Store callback for testing
                mockMqtt._commandCallback = callback;
            }),
            unsubscribe: jest.fn().mockResolvedValue(),
        };

        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
    });

    describe('constructor', () => {
        it('should construct with valid config', () => {
            const config = {
                topic: 'paradox/houdini/lights/mirror',
                host: '192.168.1.100',
                api_key: 'test-key-123',
            };

            adapter = new HueAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });

            expect(adapter.host).toBe('192.168.1.100');
            expect(adapter.port).toBe(80); // default
            expect(adapter.apiKey).toBe('test-key-123');
            expect(adapter.brightness).toBe(100); // default
        });

        it('should use custom port if provided', () => {
            const config = {
                topic: 'paradox/houdini/lights/mirror',
                host: '192.168.1.100',
                api_key: 'test-key',
                port: 8080,
            };

            adapter = new HueAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            expect(adapter.port).toBe(8080);
        });

        it('should throw if host is missing', () => {
            const config = {
                topic: 'paradox/houdini/lights/mirror',
                api_key: 'test-key',
            };

            expect(() => {
                new HueAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            }).toThrow(/config.host and config.api_key required/);
        });

        it('should throw if api_key is missing', () => {
            const config = {
                topic: 'paradox/houdini/lights/mirror',
                host: '192.168.1.100',
            };

            expect(() => {
                new HueAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            }).toThrow(/config.host and config.api_key required/);
        });
    });

    describe('init', () => {
        beforeEach(() => {
            adapter = new HueAdapter({
                config: {
                    topic: 'paradox/houdini/lights/mirror',
                    host: '192.168.1.100',
                    api_key: 'test-key',
                },
                mqttClient: mockMqtt,
                logger: mockLogger,
            });

            // Mock HTTP GET for lights fetch
            jest.spyOn(adapter, '_fetchLights').mockResolvedValue({
                1: { name: 'Light 1', state: { on: false, bri: 100, reachable: true } },
                2: { name: 'Light 2', state: { on: true, bri: 200, reachable: true } },
            });
        });

        it('should fetch lights and subscribe to commands', async () => {
            await adapter.init();

            expect(adapter._fetchLights).toHaveBeenCalled();
            expect(adapter.lights.size).toBe(2);
            expect(mockMqtt.subscribe).toHaveBeenCalledWith(
                'paradox/houdini/lights/mirror/commands',
                expect.any(Function)
            );
            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Initialized'));
        });

        it('should publish initial state after init', async () => {
            await adapter.init();

            expect(mockMqtt.publish).toHaveBeenCalled();
            const call = mockMqtt.publish.mock.calls.find((c) => c[0].includes('/state'));
            expect(call).toBeDefined();
            const payload = JSON.parse(call[1]);
            expect(payload.type).toBe('hue');
            expect(payload.lights['1']).toBeDefined();
        });

        it('should publish warning and throw if fetch fails', async () => {
            adapter._fetchLights.mockRejectedValue(new Error('Bridge not found'));

            await expect(adapter.init()).rejects.toThrow('Bridge not found');
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.any(String),
                expect.any(Object)
            );
        });

        it('should start polling timer', async () => {
            jest.useFakeTimers();
            await adapter.init();

            expect(adapter.updateTimer).toBeDefined();

            jest.useRealTimers();
        });
    });

    describe('executeCommand', () => {
        beforeEach(async () => {
            adapter = new HueAdapter({
                config: {
                    topic: 'paradox/houdini/lights/mirror',
                    host: '192.168.1.100',
                    api_key: 'test-key',
                },
                mqttClient: mockMqtt,
                logger: mockLogger,
            });

            jest.spyOn(adapter, '_fetchLights').mockResolvedValue({
                1: { state: { on: false, bri: 100 } },
            });
            jest.spyOn(adapter, '_setLight').mockResolvedValue();
            jest.spyOn(adapter, '_setScene').mockResolvedValue();
            jest.spyOn(adapter, '_allOn').mockResolvedValue();
            jest.spyOn(adapter, '_allOff').mockResolvedValue();

            await adapter.init();
            mockMqtt.publish.mockClear();
        });

        it('should handle setLight action', async () => {
            await adapter.executeCommand({ action: 'setLight', lightId: '1', on: true });

            expect(adapter._setLight).toHaveBeenCalledWith({ action: 'setLight', lightId: '1', on: true });
        });

        it('should handle setScene action', async () => {
            await adapter.executeCommand({ action: 'setScene', sceneId: '1' });

            expect(adapter._setScene).toHaveBeenCalledWith({ action: 'setScene', sceneId: '1' });
        });

        it('should handle allOn action', async () => {
            await adapter.executeCommand({ action: 'allOn' });

            expect(adapter._allOn).toHaveBeenCalled();
        });

        it('should handle allOff action', async () => {
            await adapter.executeCommand({ action: 'allOff' });

            expect(adapter._allOff).toHaveBeenCalled();
        });

        it('should warn on unknown action', async () => {
            await adapter.executeCommand({ action: 'unknownAction' });

            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.any(String),
                expect.any(Object)
            );
        });

        it('should warn if payload is not an object', async () => {
            await adapter.executeCommand('not an object');

            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.any(String),
                expect.any(Object)
            );
        });
    });

    describe('dispose', () => {
        beforeEach(async () => {
            adapter = new HueAdapter({
                config: {
                    topic: 'paradox/houdini/lights/mirror',
                    host: '192.168.1.100',
                    api_key: 'test-key',
                },
                mqttClient: mockMqtt,
                logger: mockLogger,
            });

            jest.spyOn(adapter, '_fetchLights').mockResolvedValue({
                1: { state: { on: false } },
            });

            await adapter.init();
        });

        it('should stop polling and unsubscribe', async () => {
            jest.useFakeTimers();

            const timerBefore = adapter.updateTimer;
            expect(timerBefore).toBeDefined();

            await adapter.dispose();

            expect(adapter.updateTimer).toBeNull();
            expect(mockMqtt.unsubscribe).toHaveBeenCalledWith('paradox/houdini/lights/mirror/commands');
            expect(adapter._disposed).toBe(true);

            jest.useRealTimers();
        });

        it('should prevent operations after dispose', async () => {
            await adapter.dispose();

            expect(() => {
                adapter._assertNotDisposed();
            }).toThrow(/Operation called after dispose/);
        });
    });

    describe('_setLight', () => {
        beforeEach(async () => {
            adapter = new HueAdapter({
                config: {
                    topic: 'paradox/houdini/lights/mirror',
                    host: '192.168.1.100',
                    api_key: 'test-key',
                },
                mqttClient: mockMqtt,
                logger: mockLogger,
            });

            jest.spyOn(adapter, '_fetchLights').mockResolvedValue({
                1: { state: { on: false, bri: 100 } },
            });
            jest.spyOn(adapter, '_httpPut').mockResolvedValue([{ success: { '/lights/1/state/on': true } }]);
            jest.spyOn(adapter, '_pollState').mockResolvedValue();

            await adapter.init();
            mockMqtt.publish.mockClear();
        });

        it('should warn if lightId is missing', async () => {
            await adapter._setLight({ on: true });

            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.any(String),
                expect.any(Object)
            );
        });

        it('should send state to Hue Bridge', async () => {
            await adapter._setLight({ lightId: '1', on: true, brightness: 200 });

            expect(adapter._httpPut).toHaveBeenCalledWith(
                expect.stringContaining('/lights/1/state'),
                expect.objectContaining({ on: true, bri: 200 })
            );
        });

        it('should clamp brightness to valid range', async () => {
            await adapter._setLight({ lightId: '1', brightness: 300 });

            const call = adapter._httpPut.mock.calls[0];
            expect(call[1].bri).toBe(254); // max

            await adapter._setLight({ lightId: '1', brightness: -50 });
            const call2 = adapter._httpPut.mock.calls[1];
            expect(call2[1].bri).toBe(0); // min
        });

        it('should publish event on success', async () => {
            await adapter._setLight({ lightId: '1', on: true });

            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/events'),
                expect.stringContaining('light-updated'),
                expect.any(Object)
            );
        });
    });

    describe('_publishState', () => {
        beforeEach(() => {
            adapter = new HueAdapter({
                config: {
                    topic: 'paradox/houdini/lights/mirror',
                    host: '192.168.1.100',
                    api_key: 'test-key',
                },
                mqttClient: mockMqtt,
                logger: mockLogger,
            });

            adapter.lights.set('1', { state: { on: true, bri: 200, reachable: true } });
            adapter.lights.set('2', { state: { on: false, bri: 0, reachable: false } });
        });

        it('should publish current state to MQTT', () => {
            adapter._publishState();

            expect(mockMqtt.publish).toHaveBeenCalled();
            const call = mockMqtt.publish.mock.calls.find((c) => c[0].includes('/state'));
            expect(call).toBeDefined();

            const payload = JSON.parse(call[1]);
            expect(payload.type).toBe('hue');
            expect(payload.lights['1']).toEqual({
                on: true,
                brightness: 200,
                reachable: true,
            });
            expect(payload.lights['2']).toEqual({
                on: false,
                brightness: 0,
                reachable: false,
            });
        });
    });
});
