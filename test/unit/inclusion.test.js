'use strict';

const EventEmitter = require('events');
const { ZWaveInclusion } = require('../../src/radios/zwave/inclusion');

class MockDriver extends EventEmitter {
    constructor({ hasController = true, failBegin = false } = {}) {
        super();
        this.beginCalls = [];
        this.stopCalls = [];
        this._hasController = hasController;
        this._failBegin = failBegin;
        if (hasController) {
            this.controller = {
                beginInclusion: async (opts) => {
                    this.beginCalls.push({ kind: 'inclusion', opts });
                    if (failBegin) throw new Error('boom');
                    return true;
                },
                stopInclusion: async () => {
                    this.stopCalls.push('inclusion');
                    return true;
                },
                beginExclusion: async () => {
                    this.beginCalls.push({ kind: 'exclusion' });
                    if (failBegin) throw new Error('boom');
                    return true;
                },
                stopExclusion: async () => {
                    this.stopCalls.push('exclusion');
                    return true;
                },
            };
        } else {
            this.controller = null;
        }
    }
}

describe('ZWaveInclusion', () => {
    test('starts in idle state', () => {
        const driver = new MockDriver();
        const inc = new ZWaveInclusion({ zwaveDriver: driver });
        expect(inc.state).toBe('idle');
        expect(inc.getStatus().active).toBe(false);
    });

    test('startInclusion transitions to including and calls controller', async () => {
        const driver = new MockDriver();
        const inc = new ZWaveInclusion({ zwaveDriver: driver, defaultTimeoutMs: 10_000 });
        const ok = await inc.startInclusion();
        expect(ok).toBe(true);
        expect(inc.state).toBe('including');
        expect(driver.beginCalls).toEqual([{ kind: 'inclusion', opts: { strategy: 2 } }]);
        const status = inc.getStatus();
        expect(status.active).toBe(true);
        expect(status.mode).toBe('inclusion');
        expect(status.radio).toBe('zwave');
    });

    test('refuses to start when already in a mode', async () => {
        const driver = new MockDriver();
        const warns = [];
        const inc = new ZWaveInclusion({ zwaveDriver: driver });
        inc.on('warning', (w) => warns.push(w));
        await inc.startInclusion();
        const ok = await inc.startInclusion();
        expect(ok).toBe(false);
        expect(warns.some((w) => w.code === 'INCLUSION_BUSY')).toBe(true);
    });

    test('warns when controller is unavailable', async () => {
        const driver = new MockDriver({ hasController: false });
        const warns = [];
        const inc = new ZWaveInclusion({ zwaveDriver: driver });
        inc.on('warning', (w) => warns.push(w));
        const ok = await inc.startInclusion();
        expect(ok).toBe(false);
        expect(warns[0].code).toBe('ZWAVE_NOT_READY');
    });

    test('surfaces controller-level start failure as warning', async () => {
        const driver = new MockDriver({ failBegin: true });
        const warns = [];
        const inc = new ZWaveInclusion({ zwaveDriver: driver });
        inc.on('warning', (w) => warns.push(w));
        const ok = await inc.startInclusion();
        expect(ok).toBe(false);
        expect(warns[0].code).toBe('INCLUSION_START_FAILED');
        expect(inc.state).toBe('idle');
    });

    test('stopInclusion returns to idle', async () => {
        const driver = new MockDriver();
        const inc = new ZWaveInclusion({ zwaveDriver: driver });
        await inc.startInclusion();
        await inc.stopInclusion();
        expect(inc.state).toBe('idle');
        expect(driver.stopCalls).toContain('inclusion');
    });

    test('controller stopped event finalizes idle', async () => {
        const driver = new MockDriver();
        const inc = new ZWaveInclusion({ zwaveDriver: driver });
        await inc.startInclusion();
        driver.emit('inclusion-stopped');
        expect(inc.state).toBe('idle');
    });

    test('timeout aborts inclusion and emits warning', async () => {
        jest.useFakeTimers();
        try {
            const driver = new MockDriver();
            const warns = [];
            const inc = new ZWaveInclusion({ zwaveDriver: driver, defaultTimeoutMs: 1000 });
            inc.on('warning', (w) => warns.push(w));
            await inc.startInclusion();
            jest.advanceTimersByTime(1000);
            // Allow stop() microtask to settle
            await Promise.resolve();
            expect(warns.some((w) => w.code === 'INCLUSION_TIMEOUT')).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    test('emits included event on node added during inclusion', async () => {
        const driver = new MockDriver();
        const inc = new ZWaveInclusion({ zwaveDriver: driver });
        const included = [];
        inc.on('included', (info) => included.push(info));
        await inc.startInclusion();
        driver.emit('zwave-node-added', { nodeId: 7 });
        expect(included).toEqual([{ nodeId: 7 }]);
    });

    test('emits excluded event on node removed during exclusion', async () => {
        const driver = new MockDriver();
        const inc = new ZWaveInclusion({ zwaveDriver: driver });
        const excluded = [];
        inc.on('excluded', (info) => excluded.push(info));
        await inc.startExclusion();
        driver.emit('zwave-node-removed', { nodeId: 9 });
        expect(excluded).toEqual([{ nodeId: 9 }]);
    });
});
