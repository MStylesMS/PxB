'use strict';

const { runInSubsystem, currentSubsystemId } = require('../../src/bridge/async-context');

describe('async-context', () => {
    test('currentSubsystemId() returns null outside any context', () => {
        expect(currentSubsystemId()).toBeNull();
    });

    test('currentSubsystemId() returns the id inside runInSubsystem()', async () => {
        await runInSubsystem('my-subsystem', async () => {
            expect(currentSubsystemId()).toBe('my-subsystem');
        });
    });

    test('context does not leak outside the runInSubsystem call', async () => {
        await runInSubsystem('scoped', async () => {
            expect(currentSubsystemId()).toBe('scoped');
        });
        expect(currentSubsystemId()).toBeNull();
    });

    test('nested runInSubsystem calls shadow correctly', async () => {
        await runInSubsystem('outer', async () => {
            expect(currentSubsystemId()).toBe('outer');
            await runInSubsystem('inner', async () => {
                expect(currentSubsystemId()).toBe('inner');
            });
            expect(currentSubsystemId()).toBe('outer');
        });
    });

    test('async operations inside context inherit the id', async () => {
        const results = [];
        await runInSubsystem('async-id', async () => {
            await Promise.resolve();
            results.push(currentSubsystemId());
            await new Promise((r) => setImmediate(r));
            results.push(currentSubsystemId());
        });
        expect(results).toEqual(['async-id', 'async-id']);
    });

    test('runInSubsystem propagates synchronous return value', () => {
        const result = runInSubsystem('sync', () => 42);
        expect(result).toBe(42);
    });
});
