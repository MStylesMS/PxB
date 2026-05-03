/**
 * test/unit/lights/wiz.test.js — Unit tests for WizAdapter
 */

'use strict';

const WizAdapter = require('../../../src/lights/wiz');

// Mock dgram to avoid real UDP calls
jest.mock('dgram', () => {
    const EventEmitter = require('events');
    const mockSocket = {
        on: jest.fn().mockReturnThis(),
        send: jest.fn(),
        close: jest.fn(),
    };
    return {
        createSocket: jest.fn(() => ({ ...mockSocket, on: jest.fn().mockReturnThis(), send: jest.fn(), close: jest.fn() })),
        _mockSocket: mockSocket,
    };
});

const dgram = require('dgram');

describe('WizAdapter', () => {
    let mockMqtt;
    let mockLogger;
    let adapter;

    const config = {
        topic: 'paradox/houdini/lights/accents',
        host: '192.168.1.150',
        port: 38899,
        brightness: 75,
        timeout_s: 3,
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
    });

    afterEach(() => {
        if (adapter && !adapter._disposed) {
            adapter._disposed = true;
        }
    });

    describe('constructor', () => {
        it('should construct with valid config', () => {
            adapter = new WizAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            expect(adapter.host).toBe('192.168.1.150');
            expect(adapter.port).toBe(38899);
            // brightness: 75% of 100 = 75 * 2.55 ≈ 191
            expect(adapter.brightness).toBe(Math.round(75 * 2.55));
        });

        it('should use default port if not provided', () => {
            const c = { ...config, port: undefined };
            adapter = new WizAdapter({ config: c, mqttClient: mockMqtt, logger: mockLogger });
            expect(adapter.port).toBe(38899);
        });

        it('should throw if host is missing', () => {
            const badConfig = { ...config, host: undefined };
            expect(() => new WizAdapter({ config: badConfig, mqttClient: mockMqtt, logger: mockLogger }))
                .toThrow('config.host is required');
        });

        it('should default brightness to 100 if not set', () => {
            const c = { ...config, brightness: undefined };
            adapter = new WizAdapter({ config: c, mqttClient: mockMqtt, logger: mockLogger });
            expect(adapter.brightness).toBe(Math.round(100 * 2.55));
        });
    });

    describe('executeCommand', () => {
        beforeEach(() => {
            adapter = new WizAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            jest.spyOn(adapter, '_applyColorScene').mockResolvedValue();
            jest.spyOn(adapter, '_fetchState').mockResolvedValue({ on: true, brightness: 50, sceneId: 0 });
            jest.spyOn(adapter, '_publishState').mockImplementation(() => {});
        });

        it('should warn on invalid payload type', async () => {
            await adapter.executeCommand(null);
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('WIZ_CMD_INVALID'),
                expect.any(Object)
            );
        });

        it('should warn on unknown action', async () => {
            await adapter.executeCommand({ action: 'flashMorse' });
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('WIZ_CMD_UNKNOWN'),
                expect.any(Object)
            );
        });

        it('should handle setColorScene action', async () => {
            await adapter.executeCommand({ action: 'setColorScene', scene: 'cyan' });

            expect(adapter._applyColorScene).toHaveBeenCalledWith('cyan');
        });

        it('should reject commands after disposal', async () => {
            adapter._markDisposed();
            await expect(adapter.executeCommand({ action: 'allOn' }))
                .rejects.toThrow('dispose');
        });
    });

    describe('_send', () => {
        it('should return parsed response on success', async () => {
            adapter = new WizAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });

            const fakeResponse = { method: 'getPilot', result: { state: true, dimming: 80 } };
            const EventEmitter = require('events');
            const mockSocket = {
                _messageCallbacks: [],
                _errorCallbacks: [],
                on: jest.fn((event, cb) => {
                    if (event === 'message') mockSocket._messageCallbacks.push(cb);
                    if (event === 'error') mockSocket._errorCallbacks.push(cb);
                    return mockSocket;
                }),
                send: jest.fn((data, port, host, cb) => {
                    cb && cb(null);
                    // Trigger message response
                    process.nextTick(() => {
                        mockSocket._messageCallbacks.forEach((cb) =>
                            cb(Buffer.from(JSON.stringify(fakeResponse)))
                        );
                    });
                }),
                close: jest.fn(),
            };
            dgram.createSocket.mockReturnValueOnce(mockSocket);

            const resp = await adapter._send({ method: 'getPilot', params: {} });
            expect(resp).toEqual(fakeResponse);
        });
    });

    describe('dispose', () => {
        it('should mark adapter as disposed', async () => {
            adapter = new WizAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            await adapter.dispose();
            expect(adapter._disposed).toBe(true);
        });

        it('should throw on double-dispose', async () => {
            adapter = new WizAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            await adapter.dispose();
            await expect(adapter.dispose()).rejects.toThrow('dispose');
        });
    });

    describe('scene_map parsing', () => {
        it('should allow scene_map overrides from config', () => {
            adapter = new WizAdapter({
                config: {
                    ...config,
                    scene_map: '{"cyan":{"state":true,"r":1,"g":2,"b":3,"dimming":40}}',
                },
                mqttClient: mockMqtt,
                logger: mockLogger,
            });

            expect(adapter.sceneMap.cyan).toEqual({ state: true, r: 1, g: 2, b: 3, dimming: 40 });
        });
    });
});
