/**
 * test/unit/subsystem-registry.crash-budget.test.js
 *
 * Step C: crash budget, cooling-down, and quarantine tests.
 *
 * All timing is driven by fake timers so nothing real waits 60 s.
 */

'use strict';

const { SubsystemRegistry } = require('../../src/bridge/subsystem-registry');

// ---- Helpers ----------------------------------------------------------------

function makeRegistry(opts = {}) {
    return new SubsystemRegistry({
        crashWindowMs: 60_000,
        crashLimitWarn: 3,
        crashLimitCool: 10,
        cooldownMs: 60_000,
        ...opts,
    });
}

function registerOpt(registry, id = 'test-sub') {
    const onCrash = jest.fn().mockResolvedValue(undefined);
    registry.register({ id, kind: 'output-adapter', criticality: 'optional', onCrash });
    return onCrash;
}

const ERR = new Error('simulated crash');

// ---- Within budget (≤ CRASH_LIMIT_WARN) ------------------------------------

describe('Crash budget — within limit (≤ 3)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('3 crashes in window → onCrash called each time, status remains "crashed" (contained)', async () => {
        const reg = makeRegistry();
        const onCrash = registerOpt(reg);

        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);

        expect(onCrash).toHaveBeenCalledTimes(3);
        expect(reg.getSummary()['test-sub']).toBe('crashed');
    });

    it('crashes after window reset are treated as fresh', async () => {
        const reg = makeRegistry();
        const onCrash = registerOpt(reg);

        // 3 crashes at t=0
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);

        // Advance past the window
        jest.advanceTimersByTime(61_000);

        // 3 more crashes — should still be within budget
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);

        expect(onCrash).toHaveBeenCalledTimes(6);
        expect(reg.getSummary()['test-sub']).toBe('crashed');
    });
});

// ---- Cooling-down (4 – 10 crashes) -----------------------------------------

describe('Crash budget — cooling-down (4th crash)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('4th crash → status becomes "cooling-down"', async () => {
        const reg = makeRegistry();
        registerOpt(reg);

        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR); // 4th

        expect(reg.getSummary()['test-sub']).toBe('cooling-down');
    });

    it('4th crash → onCrash called once for the transition, then suppressed', async () => {
        const reg = makeRegistry();
        const onCrash = registerOpt(reg);

        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR); // enters cooling-down

        const callsAtCooldown = onCrash.mock.calls.length;

        // Further crashes during cooldown are suppressed
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);

        expect(onCrash).toHaveBeenCalledTimes(callsAtCooldown); // no additional calls
    });

    it('cooling-down expires → crash window resets, crashes are contained again', async () => {
        const reg = makeRegistry();
        const onCrash = registerOpt(reg);

        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR); // enters cooling-down

        const callsBefore = onCrash.mock.calls.length;

        // Advance past the cooldown period
        jest.advanceTimersByTime(61_000);

        // Now crashes should be contained again
        await reg.crash('test-sub', ERR);
        expect(onCrash).toHaveBeenCalledTimes(callsBefore + 1);

        const status = reg.getSummary()['test-sub'];
        expect(['crashed', 'cooling-down']).toContain(status);
    });

    it('publishWarning is called with SUBSYSTEM_CRASH on each non-suppressed crash', async () => {
        const publishWarning = jest.fn();
        const reg = makeRegistry({ publishWarning });
        registerOpt(reg);

        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        // 4th crash triggers cooling-down — still emits the crash warning for that event
        await reg.crash('test-sub', ERR);

        const crashWarnings = publishWarning.mock.calls.filter(
            ([w]) => w.code === 'SUBSYSTEM_CRASH',
        );
        expect(crashWarnings.length).toBe(4);

        // Further crashes during cooldown are suppressed — no new warnings
        await reg.crash('test-sub', ERR);
        const crashWarnings2 = publishWarning.mock.calls.filter(
            ([w]) => w.code === 'SUBSYSTEM_CRASH',
        );
        expect(crashWarnings2.length).toBe(4);
    });
});

// ---- Quarantine (pathological loop) ----------------------------------------

describe('Crash budget — quarantine', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('second cooldown cycle with continued crashes → quarantined', async () => {
        // Use a very low budget to hit quarantine without 20+ crashes
        const reg = makeRegistry({ crashLimitWarn: 1, crashLimitCool: 2, cooldownMs: 5_000 });
        const onCrash = registerOpt(reg);

        // First cycle: 3 crashes → cooling-down
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        expect(reg.getSummary()['test-sub']).toBe('cooling-down');

        // Cooldown expires
        jest.advanceTimersByTime(6_000);

        // Resume crashing past the limit again → quarantined
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);

        expect(reg.getSummary()['test-sub']).toBe('quarantined');
        expect(onCrash).toHaveBeenCalled();
    });

    it('quarantined subsystem: all further crashes are silently suppressed', async () => {
        const reg = makeRegistry({ crashLimitWarn: 1, crashLimitCool: 2, cooldownMs: 5_000 });
        const onCrash = registerOpt(reg);

        // Drive to quarantine
        for (let i = 0; i < 3; i++) await reg.crash('test-sub', ERR);
        jest.advanceTimersByTime(6_000);
        for (let i = 0; i < 3; i++) await reg.crash('test-sub', ERR);
        expect(reg.getSummary()['test-sub']).toBe('quarantined');

        const callsAtQuarantine = onCrash.mock.calls.length;

        // Many more crashes — all suppressed
        for (let i = 0; i < 10; i++) await reg.crash('test-sub', ERR);

        expect(onCrash).toHaveBeenCalledTimes(callsAtQuarantine);
    });

    it('publishWarning emits SUBSYSTEM_QUARANTINED exactly once', async () => {
        const publishWarning = jest.fn();
        const reg = makeRegistry({ publishWarning, crashLimitWarn: 1, crashLimitCool: 2, cooldownMs: 5_000 });
        registerOpt(reg);

        for (let i = 0; i < 3; i++) await reg.crash('test-sub', ERR);
        jest.advanceTimersByTime(6_000);
        for (let i = 0; i < 3; i++) await reg.crash('test-sub', ERR);

        // More crashes after quarantine should not emit more warnings
        for (let i = 0; i < 5; i++) await reg.crash('test-sub', ERR);

        const quarantineWarnings = publishWarning.mock.calls.filter(
            ([w]) => w.code === 'SUBSYSTEM_QUARANTINED',
        );
        expect(quarantineWarnings.length).toBe(1);
        expect(quarantineWarnings[0][0].context.subsystem_id).toBe('test-sub');
        expect(quarantineWarnings[0][0].context).toHaveProperty('crash_count');
        expect(quarantineWarnings[0][0].context).toHaveProperty('window_s');
    });

    it('getSummary includes quarantined status', async () => {
        const reg = makeRegistry({ crashLimitWarn: 1, crashLimitCool: 2, cooldownMs: 5_000 });
        registerOpt(reg);

        for (let i = 0; i < 3; i++) await reg.crash('test-sub', ERR);
        jest.advanceTimersByTime(6_000);
        for (let i = 0; i < 3; i++) await reg.crash('test-sub', ERR);

        expect(reg.getSummary()).toEqual({ 'test-sub': 'quarantined' });
    });
});

// ---- unregister clears cooldown timer --------------------------------------

describe('unregister', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('unregistering a cooling-down subsystem clears its timer without throwing', async () => {
        const reg = makeRegistry();
        registerOpt(reg);

        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR); // enters cooling-down

        expect(() => reg.unregister('test-sub')).not.toThrow();
        expect(reg.getSummary()['test-sub']).toBeUndefined();
    });
});

// ---- constructor option overrides ------------------------------------------

describe('Constructor options', () => {
    it('accepts custom crashWindowMs, crashLimitWarn, crashLimitCool, cooldownMs', async () => {
        jest.useFakeTimers();
        const reg = makeRegistry({ crashWindowMs: 10_000, crashLimitWarn: 1, crashLimitCool: 3, cooldownMs: 5_000 });
        registerOpt(reg);

        // 2 crashes → should trigger cooling-down (limit is 1)
        await reg.crash('test-sub', ERR);
        await reg.crash('test-sub', ERR);

        expect(reg.getSummary()['test-sub']).toBe('cooling-down');
        jest.useRealTimers();
    });
});
