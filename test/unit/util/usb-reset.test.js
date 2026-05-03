'use strict';

// usb-reset.js lazily requires child_process, util, fs, and path inside the
// exported function. We mock child_process at module load time and spy on fs
// so we can control every call without replacing the whole module.

jest.mock('child_process', () => ({ execFile: jest.fn() }));

const childProcess = require('child_process');
const fs = require('fs');
const { usbReset } = require('../../../src/util/usb-reset');

// A valid fake sysfs output from udevadm (device node buried a few levels deep)
const UDEV_PATH = '/devices/platform/usb1/1-2/1-2:1.0/ttyUSB0/tty/ttyUSB0';

// Build a mock execFileAsync that accepts (cmd, args) and dispatches by command.
function buildExecMock({ udevResult, teeResult } = {}) {
    return jest.fn().mockImplementation((cmd, args) => {
        if (cmd === 'udevadm') {
            return udevResult !== undefined
                ? Promise.reject(new Error(udevResult))
                : Promise.resolve({ stdout: UDEV_PATH + '\n' });
        }
        if (cmd === 'sudo') {
            return teeResult !== undefined
                ? Promise.reject(new Error(teeResult))
                : Promise.resolve({ stdout: args.includes('0') ? '0' : '1' });
        }
        return Promise.resolve({ stdout: '' });
    });
}

describe('usbReset', () => {
    let realpathSyncSpy;
    let existsSyncSpy;
    let accessSyncSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        // Default spies: device exists and re-enumerates immediately
        realpathSyncSpy = jest.spyOn(fs, 'realpathSync').mockReturnValue('/dev/ttyUSB0');
        existsSyncSpy   = jest.spyOn(fs, 'existsSync').mockImplementation((p) => p.endsWith('authorized'));
        accessSyncSpy   = jest.spyOn(fs, 'accessSync').mockReturnValue(undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('resolves when USB reset and re-enumeration succeed', async () => {
        childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
            // promisify wraps execFile — Jest mock needs to handle both arities
            // The actual promisified version calls execFile(cmd, args, opts?, cb)
            const callback = typeof opts === 'function' ? opts : cb;
            if (cmd === 'udevadm') return callback(null, { stdout: UDEV_PATH + '\n' });
            if (cmd === 'sudo')    return callback(null, { stdout: '1' });
            callback(null, { stdout: '' });
        });

        await expect(usbReset('/dev/ttyUSB0', { pollIntervalMs: 1, pollTimeoutMs: 100 }))
            .resolves.toBeUndefined();
    });

    it('rejects when the serial path cannot be resolved', async () => {
        realpathSyncSpy.mockImplementation(() => { throw new Error('ENOENT'); });

        await expect(usbReset('/dev/nonexistent', { pollIntervalMs: 1, pollTimeoutMs: 100 }))
            .rejects.toThrow('usbReset: cannot resolve');
    });

    it('rejects when udevadm fails', async () => {
        childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
            const callback = typeof opts === 'function' ? opts : cb;
            if (cmd === 'udevadm') return callback(new Error('udevadm: not found'));
            callback(null, { stdout: '' });
        });

        await expect(usbReset('/dev/ttyUSB0', { pollIntervalMs: 1, pollTimeoutMs: 100 }))
            .rejects.toThrow('usbReset: udevadm failed');
    });

    it('rejects when no authorized file found in sysfs hierarchy', async () => {
        existsSyncSpy.mockReturnValue(false);

        childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
            const callback = typeof opts === 'function' ? opts : cb;
            callback(null, { stdout: UDEV_PATH + '\n' });
        });

        await expect(usbReset('/dev/ttyUSB0', { pollIntervalMs: 1, pollTimeoutMs: 100 }))
            .rejects.toThrow('could not find USB device sysfs path');
    });

    it('rejects when sysfs toggle (sudo tee) fails', async () => {
        childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
            const callback = typeof opts === 'function' ? opts : cb;
            if (cmd === 'udevadm') return callback(null, { stdout: UDEV_PATH + '\n' });
            if (cmd === 'sudo')    return callback(new Error('permission denied'));
            callback(null, { stdout: '' });
        });

        await expect(usbReset('/dev/ttyUSB0', { pollIntervalMs: 1, pollTimeoutMs: 100 }))
            .rejects.toThrow('usbReset: sysfs toggle failed');
    });

    it('rejects when device does not re-enumerate within timeout', async () => {
        accessSyncSpy.mockImplementation(() => { throw new Error('ENOENT'); });

        childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
            const callback = typeof opts === 'function' ? opts : cb;
            callback(null, { stdout: cmd === 'udevadm' ? UDEV_PATH + '\n' : '1' });
        });

        await expect(usbReset('/dev/ttyUSB0', { pollIntervalMs: 10, pollTimeoutMs: 50 }))
            .rejects.toThrow('did not re-enumerate within');
    });
});

