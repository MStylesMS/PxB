'use strict';

/**
 * usbReset(serialPort) — performs a USB-level power cycle on the host
 * controller port that owns `serialPort`, then waits for the device to
 * re-enumerate.
 *
 * Mechanism:
 *   1. Resolve the real /dev path (follows /dev/serial/by-id symlinks).
 *   2. Use `udevadm info` to find the USB device's sysfs path.
 *   3. Write 0 then 1 to `{usbSysfsPath}/authorized` via `sudo tee`.
 *   4. Poll until the serial symlink/path is visible again (max 5 s).
 *
 * Requires: `udevadm` on PATH (standard on all systemd/udev Linux).
 * Permissions: paradox user has NOPASSWD sudo — no extra sudoers entry needed.
 *
 * @param {string} serialPort   - e.g. '/dev/ttyUSB0' or '/dev/serial/by-id/usb-...'
 * @param {object} [opts]
 * @param {number} [opts.pollIntervalMs=500]   - how often to check re-enumeration
 * @param {number} [opts.pollTimeoutMs=5000]   - max wait for re-enumeration
 * @returns {Promise<void>}  resolves when device is back; rejects on error or timeout
 */
async function usbReset(serialPort, opts = {}) {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const fs = require('fs');
    const path = require('path');
    const execFileAsync = promisify(execFile);

    const pollIntervalMs = opts.pollIntervalMs ?? 500;
    const pollTimeoutMs  = opts.pollTimeoutMs  ?? 5000;

    // 1. Resolve real /dev path (follows symlinks)
    let realDev;
    try {
        realDev = fs.realpathSync(serialPort);
    } catch (err) {
        throw new Error(`usbReset: cannot resolve ${serialPort}: ${err.message}`);
    }

    // 2. Find USB sysfs path via udevadm
    let udevOut;
    try {
        const result = await execFileAsync('udevadm', ['info', '--query=path', `--name=${realDev}`]);
        udevOut = result.stdout.trim(); // e.g. /devices/platform/.../ttyUSB0
    } catch (err) {
        throw new Error(`usbReset: udevadm failed for ${realDev}: ${err.message}`);
    }

    // Walk up the sysfs path to find the USB device node (has 'authorized' file).
    // Typical path: /devices/platform/…/usb1/1-2/1-2:1.0/ttyUSB0/tty/ttyUSB0
    // We need:      /sys/devices/platform/…/usb1/1-2
    const sysfsFullPath = '/sys' + udevOut;
    let usbDevSysfs = sysfsFullPath;
    let found = false;
    for (let i = 0; i < 10; i++) {
        usbDevSysfs = path.dirname(usbDevSysfs);
        if (usbDevSysfs === '/' || usbDevSysfs === '/sys') break;
        if (fs.existsSync(path.join(usbDevSysfs, 'authorized'))) {
            found = true;
            break;
        }
    }
    if (!found) {
        throw new Error(`usbReset: could not find USB device sysfs path for ${realDev} (searched up from ${sysfsFullPath})`);
    }

    const authorizedPath = path.join(usbDevSysfs, 'authorized');

    // 3. Toggle authorized: 0 → 1
    try {
        await execFileAsync('sudo', ['tee', authorizedPath], { input: '0\n' });
        await new Promise((r) => setTimeout(r, 300)); // brief pause before re-enable
        await execFileAsync('sudo', ['tee', authorizedPath], { input: '1\n' });
    } catch (err) {
        throw new Error(`usbReset: sysfs toggle failed: ${err.message}`);
    }

    // 4. Poll until serial path is accessible again
    const deadline = Date.now() + pollTimeoutMs;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        try {
            fs.accessSync(serialPort);
            return; // device is back
        } catch {
            // still not visible — keep waiting
        }
    }

    throw new Error(`usbReset: device ${serialPort} did not re-enumerate within ${pollTimeoutMs}ms`);
}

module.exports = { usbReset };
