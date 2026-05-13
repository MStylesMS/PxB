'use strict';

const { SubsystemRegistry } = require('../../src/bridge/subsystem-registry');
const { runInSubsystem } = require('../../src/bridge/async-context');

describe('SubsystemRegistry', () => {
    let registry;

    beforeEach(() => {
        registry = new SubsystemRegistry();
    });

    // ------------------------------------------------------------------ register
    describe('register()', () => {
        test('registers a subsystem without error', () => {
            expect(() => {
                registry.register({
                    id: 'test-subsystem',
                    kind: 'radio',
                    criticality: 'optional',
                    onCrash: async () => {},
                });
            }).not.toThrow();
        });

        test('allows re-registration (replaces entry, resets status to ok)', async () => {
            const firstCrash = jest.fn();
            const secondCrash = jest.fn();

            registry.register({ id: 'sub', kind: 'radio', criticality: 'optional', onCrash: firstCrash });

            // Manually crash it so status becomes 'crashed'
            await registry.crash('sub', new Error('first'));
            expect(registry.getSummary().sub).toBe('crashed');

            // Re-register resets status
            registry.register({ id: 'sub', kind: 'output-adapter', criticality: 'optional', onCrash: secondCrash });
            expect(registry.getSummary().sub).toBe('ok');
        });

        test('rejects invalid id', () => {
            expect(() => registry.register({ id: '', kind: 'radio', criticality: 'optional', onCrash: () => {} }))
                .toThrow('id must be a non-empty string');
        });

        test('rejects unknown kind', () => {
            expect(() => registry.register({ id: 'x', kind: 'banana', criticality: 'optional', onCrash: () => {} }))
                .toThrow('unknown kind');
        });

        test('rejects unknown criticality', () => {
            expect(() => registry.register({ id: 'x', kind: 'radio', criticality: 'maybe', onCrash: () => {} }))
                .toThrow('unknown criticality');
        });

        test('rejects non-function onCrash', () => {
            expect(() => registry.register({ id: 'x', kind: 'radio', criticality: 'optional', onCrash: 'nope' }))
                .toThrow('onCrash must be a function');
        });
    });

    // ------------------------------------------------------------------ unregister
    describe('unregister()', () => {
        test('removes a registered subsystem', () => {
            registry.register({ id: 'sub', kind: 'radio', criticality: 'optional', onCrash: async () => {} });
            expect(registry.getSummary()).toHaveProperty('sub');
            registry.unregister('sub');
            expect(registry.getSummary()).not.toHaveProperty('sub');
        });

        test('is a no-op for unknown id', () => {
            expect(() => registry.unregister('does-not-exist')).not.toThrow();
        });
    });

    // ------------------------------------------------------------------ attribute
    describe('attribute()', () => {
        test('returns null when outside any subsystem context', () => {
            registry.register({ id: 'sub', kind: 'radio', criticality: 'optional', onCrash: async () => {} });
            expect(registry.attribute()).toBeNull();
        });

        test('returns attribution inside runInSubsystem context', async () => {
            registry.register({ id: 'zwave-driver', kind: 'radio', criticality: 'optional', onCrash: async () => {} });

            await runInSubsystem('zwave-driver', async () => {
                const attr = registry.attribute();
                expect(attr).toEqual({ subsystemId: 'zwave-driver', criticality: 'optional' });
            });
        });

        test('returns null for a context id that is not registered', async () => {
            await runInSubsystem('unregistered-id', async () => {
                expect(registry.attribute()).toBeNull();
            });
        });

        test('reflects criticality correctly for fatal subsystem', async () => {
            registry.register({ id: 'mqtt-client', kind: 'mqtt', criticality: 'fatal', onCrash: async () => {} });

            await runInSubsystem('mqtt-client', async () => {
                const attr = registry.attribute();
                expect(attr).toEqual({ subsystemId: 'mqtt-client', criticality: 'fatal' });
            });
        });
    });

    // ------------------------------------------------------------------ crash
    describe('crash()', () => {
        test('sets subsystem status to crashed', async () => {
            registry.register({ id: 'sub', kind: 'radio', criticality: 'optional', onCrash: async () => {} });
            await registry.crash('sub', new Error('boom'));
            expect(registry.getSummary().sub).toBe('crashed');
        });

        test('invokes onCrash with the error', async () => {
            const onCrash = jest.fn().mockResolvedValue(undefined);
            registry.register({ id: 'sub', kind: 'radio', criticality: 'optional', onCrash });

            const err = new Error('kaboom');
            await registry.crash('sub', err);

            expect(onCrash).toHaveBeenCalledWith(err);
        });

        test('handles non-Error reasons gracefully', async () => {
            const onCrash = jest.fn().mockResolvedValue(undefined);
            registry.register({ id: 'sub', kind: 'output-adapter', criticality: 'optional', onCrash });

            await registry.crash('sub', 'string reason');
            expect(onCrash).toHaveBeenCalledWith('string reason');
        });

        test('does not throw when onCrash itself throws', async () => {
            const onCrash = jest.fn().mockRejectedValue(new Error('handler boom'));
            registry.register({ id: 'sub', kind: 'radio', criticality: 'optional', onCrash });

            await expect(registry.crash('sub', new Error('original'))).resolves.toBeUndefined();
        });

        test('is a no-op for unknown subsystem id', async () => {
            await expect(registry.crash('unknown', new Error('err'))).resolves.toBeUndefined();
        });

        test('invokes publishWarning when provided', async () => {
            const publishWarning = jest.fn();
            const r = new SubsystemRegistry({ publishWarning });
            r.register({ id: 'sub', kind: 'radio', criticality: 'optional', onCrash: async () => {} });

            await r.crash('sub', new Error('boo'));

            expect(publishWarning).toHaveBeenCalledTimes(1);
            const [w] = publishWarning.mock.calls[0];
            expect(w.code).toBe('SUBSYSTEM_CRASH');
            expect(w.severity).toBe('error');
            expect(w.context.subsystem_id).toBe('sub');
        });

        test('does not crash the test when publishWarning throws', async () => {
            const publishWarning = jest.fn().mockImplementation(() => { throw new Error('publish fail'); });
            const r = new SubsystemRegistry({ publishWarning });
            r.register({ id: 'sub', kind: 'radio', criticality: 'optional', onCrash: async () => {} });

            await expect(r.crash('sub', new Error('boo'))).resolves.toBeUndefined();
        });
    });

    // ------------------------------------------------------------------ getSummary
    describe('getSummary()', () => {
        test('returns empty object when nothing is registered', () => {
            expect(registry.getSummary()).toEqual({});
        });

        test('returns ok status for freshly registered subsystems', () => {
            registry.register({ id: 'a', kind: 'radio', criticality: 'optional', onCrash: async () => {} });
            registry.register({ id: 'b', kind: 'output-adapter', criticality: 'optional', onCrash: async () => {} });
            expect(registry.getSummary()).toEqual({ a: 'ok', b: 'ok' });
        });

        test('reflects crashed status after crash()', async () => {
            registry.register({ id: 'sub', kind: 'radio', criticality: 'optional', onCrash: async () => {} });
            await registry.crash('sub', new Error('x'));
            expect(registry.getSummary().sub).toBe('crashed');
        });
    });
});
