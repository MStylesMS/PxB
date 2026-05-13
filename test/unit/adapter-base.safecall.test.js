/**
 * test/unit/adapter-base.safecall.test.js
 *
 * Unit tests for AdapterBase.safeCall() — the Step-B fault-isolation helper.
 *
 * Includes a monkey-patch test that asserts a thrown error inside a polled
 * function does not propagate to the process uncaughtException handler.
 */

'use strict';

const AdapterBase = require('../../src/adapter-base');

// ---- Helpers ----------------------------------------------------------------

function makeAdapter(overrides = {}) {
    const mockMqtt = {
        publish: jest.fn().mockResolvedValue(undefined),
    };
    const mockLogger = {
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
    };
    return new AdapterBase({
        name: 'TestAdapter',
        config: { topic: 'test/zone' },
        mqttClient: mockMqtt,
        logger: mockLogger,
        ...overrides,
    });
}

// ---- safeCall — basic contract ----------------------------------------------

describe('AdapterBase.safeCall', () => {
    it('should return the resolved value of fn', async () => {
        const adapter = makeAdapter();
        const result = await adapter.safeCall('work', () => 42);
        expect(result).toBe(42);
    });

    it('should await a Promise returned by fn', async () => {
        const adapter = makeAdapter();
        const result = await adapter.safeCall('async-work', async () => 'hello');
        expect(result).toBe('hello');
    });

    it('onError=warn — swallows the error and logs a warning', async () => {
        const adapter = makeAdapter();
        const err = new Error('boom');
        const result = await adapter.safeCall('failing', () => { throw err; });
        expect(result).toBeUndefined();
        expect(adapter.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('TestAdapter:failing'),
        );
    });

    it('onError=warn — publishes a warning to {topic}/warnings', async () => {
        const adapter = makeAdapter();
        await adapter.safeCall('failing', () => { throw new Error('oops'); });
        expect(adapter.mqttClient.publish).toHaveBeenCalledWith(
            'test/zone/warnings',
            expect.any(String),
            expect.objectContaining({ retain: false }),
        );
        const payload = JSON.parse(adapter.mqttClient.publish.mock.calls[0][1]);
        expect(payload.code).toBe('SAFE_CALL_ERROR');
        expect(payload.message).toContain('failing');
    });

    it('onError=warn — captures async errors too', async () => {
        const adapter = makeAdapter();
        const result = await adapter.safeCall('async-fail', async () => {
            throw new Error('async-boom');
        });
        expect(result).toBeUndefined();
        expect(adapter.logger.warn).toHaveBeenCalled();
    });

    it('onError=silent — swallows error without logging or publishing', async () => {
        const adapter = makeAdapter();
        const result = await adapter.safeCall(
            'quiet-fail', () => { throw new Error('quiet'); }, { onError: 'silent' });
        expect(result).toBeUndefined();
        expect(adapter.logger.warn).not.toHaveBeenCalled();
        expect(adapter.mqttClient.publish).not.toHaveBeenCalled();
    });

    it('onError=rethrow — propagates the error to the caller', async () => {
        const adapter = makeAdapter();
        const err = new Error('rethrown');
        await expect(
            adapter.safeCall('rethrowing', () => { throw err; }, { onError: 'rethrow' }),
        ).rejects.toThrow('rethrown');
    });
});

// ---- safeCall — subsystem context re-entry ----------------------------------

describe('AdapterBase.safeCall subsystem context', () => {
    const { runInSubsystem, currentSubsystemId } = require('../../src/bridge/async-context');

    it('re-enters subsystem context when _subsystemId is set', async () => {
        const adapter = makeAdapter();
        adapter._subsystemId = 'test-subsystem';

        let capturedId = null;
        await adapter.safeCall('ctx-test', () => {
            capturedId = currentSubsystemId();
        });

        expect(capturedId).toBe('test-subsystem');
    });

    it('runs fn without a context when _subsystemId is null', async () => {
        const adapter = makeAdapter();

        let capturedId = 'should-be-replaced';
        await runInSubsystem('outer', async () => {
            capturedId = currentSubsystemId(); // will be 'outer' inside runInSubsystem
        });
        // Outside the outer context, no subsystem id
        adapter._subsystemId = null;
        let idInsideCall = null;
        await adapter.safeCall('no-ctx', () => {
            idInsideCall = currentSubsystemId();
        });
        expect(idInsideCall).toBeNull();
    });
});

// ---- Monkey-patch test: poll error does not reach process ------------------

describe('Poll error containment (monkey-patch setInterval)', () => {
    it('a thrown error inside the polled function does not fire process.uncaughtException', (done) => {
        const adapter = makeAdapter();
        adapter._subsystemId = 'test-poll-subsystem';

        const uncaughtListener = (err) => {
            // If we reach this, the error escaped — fail the test
            done(new Error(`Error escaped to process.uncaughtException: ${err.message}`));
        };
        process.once('uncaughtException', uncaughtListener);

        // Capture the setInterval callback and invoke it manually.
        const originalSetInterval = global.setInterval;
        let pollerFn = null;
        global.setInterval = (fn, _ms) => {
            pollerFn = fn;
            return { unref: () => {}, ref: () => {} };
        };

        try {
            // Set up a poll loop like an adapter would.
            global.setInterval(
                () => adapter.safeCall('poll', () => { throw new Error('simulated-poll-error'); }),
                5000,
            );
        } finally {
            global.setInterval = originalSetInterval;
        }

        expect(pollerFn).not.toBeNull();

        // Invoke the captured callback; give it a tick to settle.
        Promise.resolve(pollerFn()).then(() => {
            // If we reach here, the error was contained.
            process.removeListener('uncaughtException', uncaughtListener);
            done();
        }).catch((err) => {
            process.removeListener('uncaughtException', uncaughtListener);
            done(new Error(`safeCall propagated an error: ${err.message}`));
        });
    });
});
