'use strict';

/**
 * Integration test: SubsystemRegistry fault containment
 *
 * Verifies that when an optional subsystem throws an uncaught exception from
 * inside a runInSubsystem() context, the global handler contains the crash and
 * keeps the other subsystem's heartbeat running.
 *
 * In production, Node.js delivers throws from timer callbacks via
 * `process.on('uncaughtException')`. Fake timers run synchronously and bypass
 * that path, so this test uses `process.emit('uncaughtException')` inside an
 * active subsystem context to faithfully reproduce the handler's logic.
 */

const { SubsystemRegistry } = require('../../src/bridge/subsystem-registry');
const { runInSubsystem } = require('../../src/bridge/async-context');

describe('Fault containment — integration', () => {
    let registry;
    let savedListeners;

    beforeEach(() => {
        registry = new SubsystemRegistry();
        // Snapshot and remove existing uncaughtException listeners.
        savedListeners = process.rawListeners('uncaughtException').slice();
        process.removeAllListeners('uncaughtException');
    });

    afterEach(() => {
        process.removeAllListeners('uncaughtException');
        for (const fn of savedListeners) {
            process.on('uncaughtException', fn);
        }
    });

    /**
     * Install the same uncaughtException handler logic as src/index.js uses.
     * Returns arrays for recording what each path observed.
     */
    function installHandler(reg) {
        const contained = [];
        const fallback = [];

        process.on('uncaughtException', (err) => {
            const attribution = reg.attribute();
            if (attribution && attribution.criticality === 'optional') {
                contained.push({ subsystemId: attribution.subsystemId, err });
                reg.crash(attribution.subsystemId, err).catch(() => {});
            } else {
                fallback.push(err);
                // In production: safeShutdown + process.exit(1)
                // In tests: just record it so we can assert
            }
        });

        return { contained, fallback };
    }

    test('attributed throw (optional) is contained; process stays up', () => {
        registry.register({
            id: 'zwave-driver', kind: 'radio', criticality: 'optional',
            onCrash: jest.fn().mockResolvedValue(undefined),
        });
        registry.register({
            id: 'hue-mirror', kind: 'output-adapter', criticality: 'optional',
            onCrash: jest.fn().mockResolvedValue(undefined),
        });

        const { contained, fallback } = installHandler(registry);

        // Simulate a throw from inside zwave-driver's async context.
        runInSubsystem('zwave-driver', () => {
            process.emit('uncaughtException', new Error('Z-Wave exploded'));
        });

        expect(contained).toHaveLength(1);
        expect(contained[0].subsystemId).toBe('zwave-driver');
        expect(fallback).toHaveLength(0);

        // The other subsystem is unaffected.
        expect(registry.getSummary()['hue-mirror']).toBe('ok');
        expect(registry.getSummary()['zwave-driver']).toBe('crashed');
    });

    test('unattributed throw reaches the fallback path', () => {
        registry.register({
            id: 'any-sub', kind: 'radio', criticality: 'optional',
            onCrash: jest.fn(),
        });
        const { contained, fallback } = installHandler(registry);

        // No runInSubsystem wrapping → no async context → unattributed.
        process.emit('uncaughtException', new Error('mystery error'));

        expect(contained).toHaveLength(0);
        expect(fallback).toHaveLength(1);
    });

    test('fatal subsystem throw reaches the fallback path', () => {
        registry.register({
            id: 'mqtt-client', kind: 'mqtt', criticality: 'fatal',
            onCrash: jest.fn(),
        });
        const { contained, fallback } = installHandler(registry);

        runInSubsystem('mqtt-client', () => {
            process.emit('uncaughtException', new Error('MQTT gone'));
        });

        expect(contained).toHaveLength(0);
        expect(fallback).toHaveLength(1);
    });

    test('two subsystems registered: crash in one leaves the other ok', async () => {
        const crashHandlerA = jest.fn().mockResolvedValue(undefined);
        const crashHandlerB = jest.fn();

        registry.register({ id: 'sub-a', kind: 'output-adapter', criticality: 'optional', onCrash: crashHandlerA });
        registry.register({ id: 'sub-b', kind: 'radio',           criticality: 'optional', onCrash: crashHandlerB });

        const { contained } = installHandler(registry);

        // Crash sub-a
        runInSubsystem('sub-a', () => {
            process.emit('uncaughtException', new Error('sub-a crash'));
        });

        // Simulate a heartbeat from sub-b (no crash)
        let heartbeatCount = 0;
        runInSubsystem('sub-b', () => { heartbeatCount++; });
        runInSubsystem('sub-b', () => { heartbeatCount++; });

        // Allow crash() promise to settle
        await Promise.resolve();

        expect(contained[0].subsystemId).toBe('sub-a');
        expect(registry.getSummary()['sub-a']).toBe('crashed');
        expect(registry.getSummary()['sub-b']).toBe('ok');
        expect(crashHandlerA).toHaveBeenCalledTimes(1);
        expect(crashHandlerB).not.toHaveBeenCalled();
        expect(heartbeatCount).toBe(2);
    });
});

