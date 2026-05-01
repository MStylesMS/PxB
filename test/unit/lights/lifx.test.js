/**
 * test/unit/lights/lifx.test.js — Unit tests for LifxAdapter
 */

'use strict';

const LifxAdapter = require('../../../src/lights/lifx');

// Mock the 'https' module to avoid real network calls
jest.mock('https', () => {
    const EventEmitter = require('events');
    const mockRequest = () => {
        const req = new EventEmitter();
        req.write = jest.fn();
        req.end = jest.fn();
        req.destroy = jest.fn();
        return req;
    };
    return { request: jest.fn(mockRequest) };
});

const https = require('https');

function mockHttpResponse(statusCode, body) {
    const EventEmitter = require('events');
    const req = new EventEmitter();
    req.write = jest.fn();
    req.end = jest.fn(() => {
        // Simulate successful response
        const res = new EventEmitter();
        process.nextTick(() => {
            res.emit('data', JSON.stringify(body));
            res.emit('end');
        });
        // Invoke the callback passed to https.request
        if (https.request.mock.calls.length > 0) {
            const lastCall = https.request.mock.calls[https.request.mock.calls.length - 1];
            if (typeof lastCall[1] === 'function') lastCall[1](res);
        }
    });
    req.destroy = jest.fn();
    return req;
}

describe('LifxAdapter', () => {
    let mockMqtt;
    let mockLogger;
    let adapter;

    const config = {
        topic: 'paradox/houdini/lights/room',
        api_key: 'test-lifx-token',
        selector: 'all',
        brightness: 80,
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
            adapter._disposed = true; // force-mark to suppress warnings
        }
    });

    describe('constructor', () => {
        it('should construct with valid config', () => {
            adapter = new LifxAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            expect(adapter.apiKey).toBe('test-lifx-token');
            expect(adapter.selector).toBe('all');
            expect(adapter.brightness).toBeCloseTo(0.80, 2);
        });

        it('should throw if api_key is missing', () => {
            const badConfig = { ...config, api_key: undefined };
            expect(() => new LifxAdapter({ config: badConfig, mqttClient: mockMqtt, logger: mockLogger }))
                .toThrow('api_key is required');
        });

        it('should default selector to "all"', () => {
            const c = { ...config, selector: undefined };
            adapter = new LifxAdapter({ config: c, mqttClient: mockMqtt, logger: mockLogger });
            expect(adapter.selector).toBe('all');
        });
    });

    describe('executeCommand', () => {
        beforeEach(() => {
            adapter = new LifxAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
        });

        it('should warn on invalid payload type', async () => {
            await adapter.executeCommand('not-an-object');
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('LIFX_CMD_INVALID'),
                expect.any(Object)
            );
        });

        it('should warn on unknown action', async () => {
            await adapter.executeCommand({ action: 'laserShow' });
            expect(mockMqtt.publish).toHaveBeenCalledWith(
                expect.stringContaining('/warnings'),
                expect.stringContaining('LIFX_CMD_UNKNOWN'),
                expect.any(Object)
            );
        });

        it('should reject commands after disposal', async () => {
            adapter._markDisposed();
            await expect(adapter.executeCommand({ action: 'allOn' }))
                .rejects.toThrow('dispose');
        });
    });

    describe('dispose', () => {
        it('should mark adapter as disposed', async () => {
            adapter = new LifxAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            await adapter.dispose();
            expect(adapter._disposed).toBe(true);
        });

        it('should throw on double-dispose', async () => {
            adapter = new LifxAdapter({ config, mqttClient: mockMqtt, logger: mockLogger });
            await adapter.dispose();
            await expect(adapter.dispose()).rejects.toThrow('dispose');
        });
    });
});
