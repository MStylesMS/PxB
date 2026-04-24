'use strict';

const EventEmitter = require('events');
const { ZigbeeInclusion } = require('../../src/radios/zigbee/inclusion');

function makeMockDriver({ connected = true } = {}) {
    const ee = new EventEmitter();
    const controller = {
        permitJoin: jest.fn((a, b, c) => Promise.resolve()),
    };
    // Arity=3 path
    Object.defineProperty(controller.permitJoin, 'length', { value: 3 });
    ee.controller = connected ? controller : null;
    ee._emit = (...a) => ee.emit(...a);
    return { driver: ee, controller };
}

describe('ZigbeeInclusion', () => {
    test('startInclusion() calls permitJoin with (true, undefined, seconds)', async () => {
        const { driver, controller } = makeMockDriver();
        const incl = new ZigbeeInclusion({ zigbeeDriver: driver, defaultTimeoutMs: 30_000 });
        const ok = await incl.startInclusion({ timeoutMs: 10_000 });
        expect(ok).toBe(true);
        expect(controller.permitJoin).toHaveBeenCalledWith(true, undefined, 10);
        expect(incl.getStatus().active).toBe(true);
        expect(incl.getStatus().radio).toBe('zigbee');
        await incl.stopInclusion();
    });

    test('startInclusion() emits INCLUSION_NOT_READY when no controller', async () => {
        const { driver } = makeMockDriver({ connected: false });
        const incl = new ZigbeeInclusion({ zigbeeDriver: driver });
        const warns = [];
        incl.on('warning', (w) => warns.push(w));
        const ok = await incl.startInclusion({ timeoutMs: 1000 });
        expect(ok).toBe(false);
        expect(warns.some((w) => w.code === 'ZIGBEE_NOT_READY')).toBe(true);
    });

    test('startExclusion() refuses and emits ZIGBEE_NO_EXCLUSION_MODE', async () => {
        const { driver } = makeMockDriver();
        const incl = new ZigbeeInclusion({ zigbeeDriver: driver });
        const warns = [];
        incl.on('warning', (w) => warns.push(w));
        const ok = await incl.startExclusion({ timeoutMs: 1000 });
        expect(ok).toBe(false);
        expect(warns.some((w) => w.code === 'ZIGBEE_NO_EXCLUSION_MODE')).toBe(true);
    });

    test('permitJoinChanged(permitted=false) finalizes inclusion', async () => {
        const { driver } = makeMockDriver();
        const incl = new ZigbeeInclusion({ zigbeeDriver: driver, defaultTimeoutMs: 30_000 });
        await incl.startInclusion({ timeoutMs: 10_000 });
        expect(incl.getStatus().active).toBe(true);
        driver.emit('zigbee-permit-join-changed', { permitted: false });
        expect(incl.getStatus().active).toBe(false);
    });
});
