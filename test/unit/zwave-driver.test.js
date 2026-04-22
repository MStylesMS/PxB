'use strict';

const EventEmitter = require('events');
const { ZWaveDriver } = require('../../src/radios/zwave/driver');

/**
 * MockDriver is an injectable replacement for zwave-js's Driver.
 *
 * Behavior is controlled by the factory that constructs it:
 *   - If `startBehavior` is 'success': start() resolves, 'driver ready' fires on next tick.
 *   - If `startBehavior` is 'reject':  start() rejects with provided error.
 *   - If `startBehavior` is 'throw':   constructor throws.
 */
class MockDriver extends EventEmitter {
    constructor(port, opts, behavior) {
        super();
        this._port = port;
        this._opts = opts;
        this._behavior = behavior;
        this.destroyed = false;

        // Minimal controller shape for nodeCount
        this.controller = { nodes: new Map([[1, { id: 1 }]]) };
    }

    start() {
        if (this._behavior.startBehavior === 'reject') {
            return Promise.reject(this._behavior.error || new Error('mock start failed'));
        }
        // Success: emit 'driver ready' asynchronously after start() resolves
        setImmediate(() => this.emit('driver ready'));
        return Promise.resolve();
    }

    destroy() {
        this.destroyed = true;
        return Promise.resolve();
    }
}

function makeFactory(behavior = { startBehavior: 'success' }) {
    return function driverFactory(port, opts) {
        if (behavior.startBehavior === 'throw') {
            throw behavior.error || new Error('mock construct failed');
        }
        return new MockDriver(port, opts, behavior);
    };
}

function waitForEvent(emitter, event, timeoutMs = 200) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
        emitter.once(event, (...args) => { clearTimeout(t); resolve(args); });
    });
}

describe('ZWaveDriver: construction', () => {
    test('requires port option', () => {
        expect(() => new ZWaveDriver({})).toThrow('port is required');
    });

    test('initial state is stopped and reports safe defaults', () => {
        const d = new ZWaveDriver({ port: '/dev/ttyFAKE', driverFactory: makeFactory() });
        expect(d.state).toBe('stopped');
        expect(d.connected).toBe(false);
        expect(d.nodeCount).toBe(0);
        expect(d.lastError).toBeNull();
        const s = d.getStatus();
        expect(s).toMatchObject({ enabled: true, connected: false, port: '/dev/ttyFAKE', node_count: 0, state: 'stopped' });
    });
});

describe('ZWaveDriver: successful start lifecycle', () => {
    test('transitions stopped → starting → connected and emits connected', async () => {
        const d = new ZWaveDriver({ port: '/dev/ttyFAKE', driverFactory: makeFactory() });
        const states = [];
        d.on('state-changed', (next) => states.push(next));

        const connectedP = waitForEvent(d, 'connected');
        await d.start();
        await connectedP;

        expect(states).toEqual(['starting', 'connected']);
        expect(d.connected).toBe(true);
        expect(d.nodeCount).toBe(1);
        expect(d.getStatus().connected).toBe(true);

        await d.stop();
    });

    test('cannot start twice without stopping first', async () => {
        const d = new ZWaveDriver({ port: '/dev/ttyFAKE', driverFactory: makeFactory() });
        await d.start();
        await waitForEvent(d, 'connected');
        await expect(d.start()).rejects.toThrow(/state/);
        await d.stop();
    });
});

describe('ZWaveDriver: failure + reconnect', () => {
    test('constructor throw → emits warning and schedules reconnect', async () => {
        const warnings = [];
        const factory = makeFactory({ startBehavior: 'throw', error: new Error('port busy') });
        const d = new ZWaveDriver({
            port: '/dev/ttyFAKE',
            driverFactory: factory,
            backoffMinMs: 50,
            backoffMaxMs: 200,
        });
        d.on('warning', (w) => warnings.push(w));

        await d.start();

        expect(d.state).toBe('error');
        expect(d.lastError).toBe('port busy');

        const codes = warnings.map((w) => w.code);
        expect(codes).toContain('ZWAVE_DRIVER_CONSTRUCT_FAILED');
        expect(codes).toContain('ZWAVE_RECONNECT_SCHEDULED');

        await d.stop();
    });

    test('start() rejection → exponential backoff until success', async () => {
        let attempts = 0;
        const factory = (port, opts) => {
            attempts++;
            const behavior = attempts < 3
                ? { startBehavior: 'reject', error: new Error(`attempt ${attempts} failed`) }
                : { startBehavior: 'success' };
            return new MockDriver(port, opts, behavior);
        };

        const d = new ZWaveDriver({
            port: '/dev/ttyFAKE',
            driverFactory: factory,
            backoffMinMs: 20,
            backoffMaxMs: 200,
        });

        await d.start();
        expect(attempts).toBe(1);
        expect(d.state).toBe('error');

        // Wait for a successful connection to be emitted (through 2 reconnects)
        await waitForEvent(d, 'connected', 2000);
        expect(attempts).toBe(3);
        expect(d.state).toBe('connected');
        expect(d.lastError).toBeNull();

        await d.stop();
    }, 5000);

    test('backoff grows exponentially up to max', async () => {
        const delays = [];
        const factory = makeFactory({ startBehavior: 'reject', error: new Error('fail') });
        const d = new ZWaveDriver({
            port: '/dev/ttyFAKE',
            driverFactory: factory,
            backoffMinMs: 10,
            backoffMaxMs: 80,
        });
        d.on('warning', (w) => {
            if (w.code === 'ZWAVE_RECONNECT_SCHEDULED') delays.push(w.context.backoff_ms);
        });

        await d.start();
        // Let a few reconnect cycles occur
        await new Promise((r) => setTimeout(r, 300));
        await d.stop();

        // Expect a growing sequence that saturates at backoffMaxMs
        expect(delays.length).toBeGreaterThanOrEqual(3);
        expect(delays[0]).toBe(10);
        expect(delays[1]).toBe(20);
        expect(Math.max(...delays)).toBeLessThanOrEqual(80);
        expect(delays[delays.length - 1]).toBe(80); // saturated
    }, 5000);

    test('stop() during backoff cancels pending reconnect', async () => {
        let attempts = 0;
        const factory = (port, opts) => {
            attempts++;
            return new MockDriver(port, opts, { startBehavior: 'reject', error: new Error('fail') });
        };
        const d = new ZWaveDriver({
            port: '/dev/ttyFAKE',
            driverFactory: factory,
            backoffMinMs: 100,
            backoffMaxMs: 1000,
        });
        await d.start();
        expect(attempts).toBe(1);

        await d.stop();
        expect(d.state).toBe('stopped');

        // Wait well past the backoff window — no new attempts should happen
        await new Promise((r) => setTimeout(r, 300));
        expect(attempts).toBe(1);
    }, 5000);
});

describe('ZWaveDriver: non-fatal driver error', () => {
    test('connected → degraded on runtime error and emits warning', async () => {
        const warnings = [];
        let capturedDriver;
        const factory = (port, opts) => {
            capturedDriver = new MockDriver(port, opts, { startBehavior: 'success' });
            return capturedDriver;
        };
        const d = new ZWaveDriver({ port: '/dev/ttyFAKE', driverFactory: factory });
        d.on('warning', (w) => warnings.push(w));

        await d.start();
        await waitForEvent(d, 'connected');
        expect(d.state).toBe('connected');

        capturedDriver.emit('error', new Error('transient glitch'));

        expect(d.state).toBe('degraded');
        const codes = warnings.map((w) => w.code);
        expect(codes).toContain('ZWAVE_DRIVER_ERROR');
        expect(d.lastError).toBe('transient glitch');

        await d.stop();
    });
});
