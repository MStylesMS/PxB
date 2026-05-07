'use strict';

const EventEmitter = require('events');
const { ZigbeeDriver } = require('../../src/radios/zigbee/driver');

/**
 * MockHerdsmanController — injectable replacement for zigbee-herdsman Controller.
 */
class MockHerdsmanController extends EventEmitter {
    constructor(opts, behavior) {
        super();
        this._opts = opts;
        this._behavior = behavior;
        this.stopped = false;
    }

    start() {
        if (this._behavior.startBehavior === 'reject') {
            return Promise.reject(this._behavior.error || new Error('mock herdsman start failed'));
        }
        return Promise.resolve();
    }

    stop() {
        this.stopped = true;
        return Promise.resolve();
    }

    getDevices() { return []; }

    getDeviceByIeeeAddr(ieee) {
        return (this._devices || []).find((d) => d.ieeeAddr === ieee) || null;
    }

    permitJoin(...args) {
        this.permitJoinArgs = args;
        return Promise.resolve();
    }
}

function makeFactory(behavior = { startBehavior: 'success' }) {
    return function factory(opts) {
        if (behavior.startBehavior === 'throw') {
            throw behavior.error || new Error('mock construct failed');
        }
        const c = new MockHerdsmanController(opts, behavior);
        behavior.instance = c;
        return c;
    };
}

function waitForEvent(emitter, event, timeoutMs = 200) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
        emitter.once(event, (...args) => { clearTimeout(t); resolve(args); });
    });
}

describe('ZigbeeDriver', () => {
    test('constructor rejects unsupported adapter values', () => {
        expect(() => {
            new ZigbeeDriver({
                port: '/dev/ttyUSB1',
                adapter: 'zstack',
                controllerFactory: makeFactory(),
            });
        }).toThrow('unsupported adapter');
    });

    test('constructor pins adapter to ember when omitted', () => {
        const d = new ZigbeeDriver({
            port: '/dev/ttyUSB1',
            controllerFactory: makeFactory(),
        });
        expect(d.getStatus().adapter).toBe('ember');
    });

    test('start(): enters connected on successful controller start', async () => {
        const behavior = { startBehavior: 'success' };
        const d = new ZigbeeDriver({
            port: '/dev/ttyUSB1', adapter: 'ember',
            databasePath: '/tmp/zigbee.db',
            controllerFactory: makeFactory(behavior),
        });
        const p = waitForEvent(d, 'connected');
        await d.start();
        await p;
        expect(d.connected).toBe(true);
        expect(d.state).toBe('connected');
        await d.stop();
    });

    test('builds default network backup path as zigbee-network.db beside db_path', async () => {
        const behavior = { startBehavior: 'success' };
        const d = new ZigbeeDriver({
            port: '/dev/ttyUSB1',
            adapter: 'ember',
            databasePath: '/opt/paradox/config/zigbee.db',
            controllerFactory: makeFactory(behavior),
        });

        await d.start();
        expect(behavior.instance._opts.databasePath).toBe('/opt/paradox/config/zigbee.db');
        expect(behavior.instance._opts.databaseBackupPath).toBe('/opt/paradox/config/zigbee.db.backup');
        expect(behavior.instance._opts.backupPath).toBe('/opt/paradox/config/zigbee-network.db');
        await d.stop();
    });

    test('start(): rejection is captured → warning emitted and reconnect scheduled', async () => {
        const behavior = { startBehavior: 'reject', error: new Error('no port') };
        const d = new ZigbeeDriver({
            port: '/dev/ttyUSB1',
            controllerFactory: makeFactory(behavior),
            backoffMinMs: 10, backoffMaxMs: 20,
        });
        const warnings = [];
        d.on('warning', (w) => warnings.push(w));
        await d.start();
        // Give the async failure handler a tick to run.
        await new Promise((r) => setImmediate(r));
        expect(['error', 'degraded', 'stopped']).toContain(d.state);
        expect(warnings.some((w) => w.code === 'ZIGBEE_START_FAILED')).toBe(true);
        await d.stop();
    });

    test('adapterDisconnected → state=disconnected and reconnect scheduled', async () => {
        const behavior = { startBehavior: 'success' };
        const d = new ZigbeeDriver({
            port: '/dev/ttyUSB1',
            controllerFactory: makeFactory(behavior),
            backoffMinMs: 10, backoffMaxMs: 20,
        });
        await d.start();
        const p = waitForEvent(d, 'disconnected', 400);
        behavior.instance.emit('adapterDisconnected');
        await p;
        expect(d.connected).toBe(false);
        await d.stop();
    });

    test('forwards deviceJoined, deviceLeave, deviceInterview, message', async () => {
        const behavior = { startBehavior: 'success' };
        const d = new ZigbeeDriver({
            port: '/dev/ttyUSB1',
            controllerFactory: makeFactory(behavior),
        });
        await d.start();

        const joined = waitForEvent(d, 'zigbee-device-joined');
        behavior.instance.emit('deviceJoined', {
            device: { ieeeAddr: '0x00124b0012345678', networkAddress: 42, modelID: 'FOO' },
        });
        const [jEvt] = await joined;
        expect(jEvt.ieee).toBe('0x00124b0012345678');
        expect(jEvt.networkAddress).toBe(42);
        expect(jEvt.modelId).toBe('FOO');

        const left = waitForEvent(d, 'zigbee-device-left');
        behavior.instance.emit('deviceLeave', { ieeeAddr: '0x00124b0012345678' });
        const [lEvt] = await left;
        expect(lEvt.ieee).toBe('0x00124b0012345678');

        const interview = waitForEvent(d, 'zigbee-device-interview');
        behavior.instance.emit('deviceInterview', {
            status: 'successful',
            device: { ieeeAddr: '0x00124b0012345678' },
        });
        const [iEvt] = await interview;
        expect(iEvt.status).toBe('successful');

        const msg = waitForEvent(d, 'zigbee-message');
        behavior.instance.emit('message', {
            device: { ieeeAddr: '0x00124b0012345678' },
            endpoint: { ID: 1 },
            cluster: 'ssIasZone',
            type: 'commandStatusChangeNotification',
            data: { zonestatus: 1 },
        });
        const [mEvt] = await msg;
        expect(mEvt.cluster).toBe('ssIasZone');
        expect(mEvt.data.zonestatus).toBe(1);

        await d.stop();
    });

    describe('USB reset on first startup failure', () => {
        let mockUsbReset;

        beforeEach(() => {
            jest.resetModules();
            mockUsbReset = jest.fn().mockResolvedValue();
            jest.doMock('../../src/util/usb-reset', () => ({ usbReset: mockUsbReset }));
        });

        afterEach(() => {
            jest.dontMock('../../src/util/usb-reset');
        });

        test('attempts USB reset on first start when HOST_FATAL_ERROR occurs', async () => {
            const { ZigbeeDriver: FreshDriver } = require('../../src/radios/zigbee/driver');
            const fatalErr = new Error('Failed to start: HOST_FATAL_ERROR');
            let attempt = 0;
            const factory = () => {
                attempt++;
                return new MockHerdsmanController({}, {
                    startBehavior: attempt === 1 ? 'reject' : 'success',
                    error: fatalErr,
                });
            };
            const d = new FreshDriver({
                port: '/dev/ttyUSB0',
                controllerFactory: factory,
                backoffMinMs: 10,
                backoffMaxMs: 50,
            });
            const warnings = [];
            d.on('warning', (w) => warnings.push(w));

            // Start will fail, trigger USB reset, schedule reconnect
            await d.start().catch(() => {});
            // Wait for reconnect + second attempt
            await waitForEvent(d, 'connected', 500);

            expect(mockUsbReset).toHaveBeenCalledWith('/dev/ttyUSB0');
            expect(warnings.some((w) => w.code === 'ZIGBEE_USB_RESET_ATTEMPT')).toBe(true);
            await d.stop();
        });

        test('does NOT attempt USB reset on second startup failure', async () => {
            const { ZigbeeDriver: FreshDriver } = require('../../src/radios/zigbee/driver');
            const fatalErr = new Error('HOST_FATAL_ERROR');
            let attempt = 0;
            const factory = () => {
                attempt++;
                return new MockHerdsmanController({}, { startBehavior: 'reject', error: fatalErr });
            };
            const d = new FreshDriver({
                port: '/dev/ttyUSB0',
                controllerFactory: factory,
                backoffMinMs: 10,
                backoffMaxMs: 50,
            });

            // First attempt — USB reset fires
            await d.start().catch(() => {});
            // Advance backoff by waiting for first reconnect
            await new Promise((r) => setTimeout(r, 30));
            const resetCallsAfterFirst = mockUsbReset.mock.calls.length;

            // Second reconnect should NOT call usbReset
            await new Promise((r) => setTimeout(r, 60));
            expect(mockUsbReset.mock.calls.length).toBe(resetCallsAfterFirst);

            await d.stop();
        });

        test('continues to reconnect even if USB reset itself fails', async () => {
            const { ZigbeeDriver: FreshDriver } = require('../../src/radios/zigbee/driver');
            mockUsbReset.mockRejectedValue(new Error('sudo failed'));
            const fatalErr = new Error('HOST_FATAL_ERROR');
            let attempt = 0;
            const factory = () => {
                attempt++;
                return new MockHerdsmanController({}, {
                    startBehavior: attempt === 1 ? 'reject' : 'success',
                    error: fatalErr,
                });
            };
            const d = new FreshDriver({
                port: '/dev/ttyUSB0',
                controllerFactory: factory,
                backoffMinMs: 10,
                backoffMaxMs: 50,
            });

            await d.start().catch(() => {});
            // Should still reconnect and succeed despite USB reset failure
            await waitForEvent(d, 'connected', 500);
            expect(d.state).toBe('connected');
            await d.stop();
        });
    });
});
