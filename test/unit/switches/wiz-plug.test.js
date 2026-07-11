/**
 * test/unit/switches/wiz-plug.test.js — Unit tests for WizPlugAdapter
 */

'use strict';

const WizPlugAdapter = require('../../../src/switches/wiz-plug');

// Mock dgram to avoid real UDP calls
jest.mock('dgram', () => {
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

/**
 * Helper: make the next createSocket call resolve with a given WiZ response body.
 */
function setUdpResponse(body) {
    const mockSocket = {
        _messageCallbacks: [],
        _errorCallbacks: [],
        on: jest.fn((event, cb) => {
            if (event === 'message') mockSocket._messageCallbacks.push(cb);
            if (event === 'error') mockSocket._errorCallbacks.push(cb);
            return mockSocket;
        }),
        send: jest.fn((data, port, host, cb) => {
            if (cb) cb(null);
            process.nextTick(() => {
                mockSocket._messageCallbacks.forEach((mcb) =>
                    mcb(Buffer.from(JSON.stringify(body))));
            });
        }),
        close: jest.fn(),
    };
    dgram.createSocket.mockReturnValueOnce(mockSocket);
}

describe('WizPlugAdapter', () => {
    let mockMqtt;
    let mockLogger;
    let adapter;

    const config = {
        topic: 'paradox/houdini/switches/wiz-plug-main',
        host: '192.168.1.130',
        port: 38899,
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
            adapter = new WizPlugAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            expect(adapter.host).toBe('192.168.1.130');
            expect(adapter.port).toBe(38899);
        });

        it('should use default UDP port if not provided', () => {
            const c = { ...config, port: undefined };
            adapter = new WizPlugAdapter({ config: c, mqttClient: mockMqtt, logger: mockLogger });
            expect(adapter.port).toBe(38899);
        });

        it('should throw if host is missing', () => {
            const badConfig = { ...config, host: undefined };
            expect(() => new WizPlugAdapter({ config: badConfig, mqttClient: mockMqtt, logger: mockLogger }))
                .toThrow('config.host is required');
        });

        it('should seed a single channel-0 relay', () => {
            adapter = new WizPlugAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            expect(adapter.relays).toEqual([{ id: 0, on: false }]);
        });
    });

    describe('executeCommand', () => {
        beforeEach(() => {
            adapter = new WizPlugAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            jest.spyOn(adapter, '_setState').mockResolvedValue();
            jest.spyOn(adapter, '_fetchRelayStatus').mockResolvedValue([{ id: 0, on: true }]);
            jest.spyOn(adapter, '_publishState').mockImplementation(() => {});
        });

        it('should warn on invalid payload', async () => {
            await adapter.executeCommand('bad-input');
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('WIZ_PLUG_CMD_INVALID'),
                expect.any(Object)
            );
        });

        it('should warn on unknown action', async () => {
            await adapter.executeCommand({ action: 'selfDestruct' });
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('WIZ_PLUG_CMD_UNKNOWN'),
                expect.any(Object)
            );
        });

        it('should turn the plug on via setRelay', async () => {
            await adapter.executeCommand({ command: 'setRelay', on: true });
            expect(adapter._setState).toHaveBeenCalledWith(true);
        });

        it('should turn the plug off via setRelay', async () => {
            await adapter.executeCommand({ command: 'setRelay', on: false });
            expect(adapter._setState).toHaveBeenCalledWith(false);
        });

        it('should map allOn / allOff to a single channel', async () => {
            await adapter.executeCommand({ command: 'allOn' });
            expect(adapter._setState).toHaveBeenCalledWith(true);
            await adapter.executeCommand({ command: 'allOff' });
            expect(adapter._setState).toHaveBeenCalledWith(false);
        });

        it('should warn but still act when a non-zero channel is requested', async () => {
            await adapter.executeCommand({ command: 'setRelay', on: true, channel: 2 });
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('WIZ_PLUG_CHANNEL_UNSUPPORTED'),
                expect.any(Object)
            );
            expect(adapter._setState).toHaveBeenCalledWith(true);
        });

        it('should reject commands after disposal', async () => {
            adapter._markDisposed();
            await expect(adapter.executeCommand({ action: 'allOn' }))
                .rejects.toThrow('dispose');
        });
    });

    describe('_setState / _fetchRelayStatus', () => {
        it('should send a setState UDP message', async () => {
            adapter = new WizPlugAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            const sendSpy = jest.spyOn(adapter, '_send').mockResolvedValue({ result: { success: true } });

            await adapter._setState(true);
            expect(sendSpy).toHaveBeenCalledWith({ method: 'setState', params: { state: true } });
        });

        it('should parse getPilot state into a channel-0 relay', async () => {
            adapter = new WizPlugAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            jest.spyOn(adapter, '_send').mockResolvedValue({ result: { state: true } });

            const relays = await adapter._fetchRelayStatus();
            expect(relays).toEqual([{ id: 0, on: true }]);
        });
    });

    describe('_send', () => {
        it('should return parsed response on success', async () => {
            adapter = new WizPlugAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });

            const fakeResponse = { method: 'getPilot', result: { state: true } };
            setUdpResponse(fakeResponse);

            const resp = await adapter._send({ method: 'getPilot', params: {} });
            expect(resp).toEqual(fakeResponse);
        });
    });

    describe('dispose', () => {
        it('should mark adapter as disposed', async () => {
            adapter = new WizPlugAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            await adapter.dispose();
            expect(adapter._disposed).toBe(true);
        });

        it('should throw on double-dispose', async () => {
            adapter = new WizPlugAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            await adapter.dispose();
            await expect(adapter.dispose()).rejects.toThrow('dispose');
        });
    });
});
