'use strict';

const { SerialPort } = require('serialport');

// BREAK: one 0x00 at 76800 baud 8N1 holds the line LOW for ~104 µs (spec ≥ 88 µs).
// MAB:   TX idle (HIGH) during the re-open sequence takes well over 8 µs on the
//        Pi5 USB serial path — no explicit sleep is needed.
// port.set({brk:true/false}) is NOT used; it is unreliable on ftdi_sio + Pi5
// and produces only occasional valid frames. See docs/pending/PR_DMX_SUPPORT.md
// Phase 0 results for the confirmation test.

const BREAK_BAUD = 76800;
const DMX_BAUD   = 250000;
const BREAK_BYTE = Buffer.from([0x00]);

function _openPort(path, baudRate, stopBits) {
    const p = new SerialPort({
        path,
        baudRate,
        dataBits: 8,
        stopBits,
        parity: 'none',
        autoOpen: false,
    });
    return new Promise((resolve, reject) => p.open((err) => (err ? reject(err) : resolve(p))));
}

function _closePort(p) {
    return new Promise((resolve, reject) => {
        p.drain((err) => {
            if (err) return reject(err);
            p.close(resolve);
        });
    });
}

function _writeAndDrain(p, buf) {
    return new Promise((resolve, reject) => {
        p.write(buf, (err) => {
            if (err) return reject(err);
            p.drain(resolve);
        });
    });
}

/**
 * OpenDmxInterface — direct FTDI FT232R DMX512 output.
 *
 * Generates BREAK via baud-rate switching:
 *   1. Open port at 76800 baud 8N1.
 *   2. Write one 0x00 byte → line held LOW for ~104 µs (valid BREAK).
 *   3. Close port.
 *   4. Re-open at 250000 baud 8N2 → TX idle is the MAB.
 *   5. Write start-code + 512 data slots.
 *   6. Drain + close.
 *
 * This approach is stateless per frame: no persistent port handle is held
 * between frames. This trades throughput (~8–10 Hz on Pi5) for reliability
 * (no lock contention, no stale handle on serial reconnects).
 */
class OpenDmxInterface {
    /**
     * Send one DMX512 frame.
     *
     * @param {string} devicePath  - Absolute serial device path.
     * @param {Buffer} frameBuffer - 513-byte buffer: [0]=start-code(0x00), [1..512]=slots.
     */
    async sendFrame(devicePath, frameBuffer) {
        // BREAK
        const brkPort = await _openPort(devicePath, BREAK_BAUD, 1);
        await _writeAndDrain(brkPort, BREAK_BYTE);
        await _closePort(brkPort);

        // MAB is implicit — re-opening takes well over 8 µs on Pi5 USB serial.

        // Frame
        const dmxPort = await _openPort(devicePath, DMX_BAUD, 2);
        await _writeAndDrain(dmxPort, frameBuffer);
        await _closePort(dmxPort);
    }
}

module.exports = { OpenDmxInterface };
