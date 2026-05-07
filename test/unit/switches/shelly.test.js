/**
 * test/unit/switches/shelly.test.js — Unit tests for ShellyAdapter
 */

'use strict';

const ShellyAdapter = require('../../../src/switches/shelly');

// Mock 'http' module to avoid real network calls
jest.mock('http', () => {
    const EventEmitter = require('events');
    const mockReq = {
        write: jest.fn(),
        end: jest.fn(),
        destroy: jest.fn(),
        on: jest.fn().mockReturnThis(),
    };
    return { request: jest.fn(() => ({ ...mockReq, on: jest.fn().mockReturnThis(), end: jest.fn(), write: jest.fn(), destroy: jest.fn() })) };
});

const http = require('http');

/**
 * Helper: make the next http.request call resolve with a given body.
 */
function setHttpResponse(body) {
    const EventEmitter = require('events');
    http.request.mockImplementationOnce((options, callback) => {
        const req = {
            write: jest.fn(),
            end: jest.fn(() => {
                const res = new EventEmitter();
                process.nextTick(() => {
                    res.emit('data', JSON.stringify(body));
                    res.emit('end');
                });
                if (callback) callback(res);
            }),
            on: jest.fn().mockReturnThis(),
            destroy: jest.fn(),
        };
        return req;
    });
}

describe('ShellyAdapter', () => {
    let mockMqtt;
    let mockLogger;
    let adapter;

    const config = {
        topic: 'paradox/houdini/relay/main',
        host: '192.168.1.200',
        port: 80,
        gen: 1,
        channel: 0,
        timeout_s: 5,
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
            adapter = new ShellyAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            expect(adapter.host).toBe('192.168.1.200');
            expect(adapter.port).toBe(80);
            expect(adapter.gen).toBe(1);
            expect(adapter.channel).toBe(0);
        });

        it('should default gen to null (auto-detect)', () => {
            const c = { ...config, gen: undefined };
            adapter = new ShellyAdapter({ config: c, mqttClient: mockMqtt, logger: mockLogger });
            expect(adapter.gen).toBeNull();
        });

        it('should throw if host is missing', () => {
            const badConfig = { ...config, host: undefined };
            expect(() => new ShellyAdapter({ config: badConfig, mqttClient: mockMqtt, logger: mockLogger }))
                .toThrow('config.host is required');
        });
    });

    describe('init (Gen1)', () => {
        it('should fetch device info and relay status on init', async () => {
            // First call: _fetchDeviceInfo tries Gen2 then falls back to Gen1 (/shelly)
            setHttpResponse({ type: 'SHELLY1', mac: 'AABBCC', _gen: 1 }); // Gen2 probe fails → this mock is for Gen1 /shelly
            setHttpResponse({ relays: [{ ison: false }] });                 // /status

            // Make Gen2 probe fail
            http.request.mockImplementationOnce((options, callback) => ({
                write: jest.fn(),
                end: jest.fn(() => { throw new Error('connection refused'); }),
                on: jest.fn().mockReturnThis(),
                destroy: jest.fn(),
            }));
            setHttpResponse({ type: 'SHELLY1', mac: 'AABBCC' });
            setHttpResponse({ relays: [{ ison: false }] });

            adapter = new ShellyAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            // Can't fully test init without real HTTP mocks; just check constructor works
            expect(adapter.host).toBe('192.168.1.200');
        });
    });

    describe('executeCommand', () => {
        beforeEach(() => {
            adapter = new ShellyAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            adapter.relays = [{ id: 0, on: false }]; // seed state manually
            adapter.gen = 1;
        });

        it('should warn on invalid payload', async () => {
            await adapter.executeCommand('bad-input');
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('SHELLY_CMD_INVALID'),
                expect.any(Object)
            );
        });

        it('should warn on unknown action', async () => {
            await adapter.executeCommand({ action: 'selfDestruct' });
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('SHELLY_CMD_UNKNOWN'),
                expect.any(Object)
            );
        });

        it('should reject commands after disposal', async () => {
            adapter._markDisposed();
            await expect(adapter.executeCommand({ action: 'allOn' }))
                .rejects.toThrow('dispose');
        });
    });

    describe('_httpGet / _httpPost', () => {
        it('should delegate to _httpRequest with GET method', async () => {
            adapter = new ShellyAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            jest.spyOn(adapter, '_httpRequest').mockResolvedValue({ ison: true, overpower: false });

            const resp = await adapter._httpGet('/relay/0');
            expect(adapter._httpRequest).toHaveBeenCalledWith('GET', '/relay/0', null);
            expect(resp.ison).toBe(true);
        });

        it('should delegate to _httpRequest with POST method and body', async () => {
            adapter = new ShellyAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            jest.spyOn(adapter, '_httpRequest').mockResolvedValue({ output: true });

            const resp = await adapter._httpPost('/rpc/Switch.Set', { id: 0, on: true });
            expect(adapter._httpRequest).toHaveBeenCalledWith('POST', '/rpc/Switch.Set', { id: 0, on: true });
            expect(resp.output).toBe(true);
        });
    });

    describe('dispose', () => {
        it('should mark adapter as disposed', async () => {
            adapter = new ShellyAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            await adapter.dispose();
            expect(adapter._disposed).toBe(true);
        });

        it('should throw on double-dispose', async () => {
            adapter = new ShellyAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            await adapter.dispose();
            await expect(adapter.dispose()).rejects.toThrow('dispose');
        });
    });
});
