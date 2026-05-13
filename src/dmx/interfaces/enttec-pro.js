'use strict';

const { SerialPort } = require('serialport');

// ── Enttec USB Pro Open Protocol ──────────────────────────────────────────
//
// Frame structure (label 6 = "Send DMX Packet Request"):
//
//   [0x7E]          Start of message
//   [label]         0x06 = Send DMX
//   [lsb]           LSB of data length (start-code byte + DMX slots)
//   [msb]           MSB of data length
//   [0x00]          DMX start code
//   [slot1..slotN]  Up to 512 DMX slot values
//   [0xE7]          End of message
//
// The data length field covers the start-code byte plus all slot bytes:
//   length = universe_size + 1
//
// Serial settings: 57600 baud, 8N1. The interface MCU generates the
// DMX break and MAB internally; the host never switches baud rates.
//
// References:
//   Enttec "DMX USB Pro Communications Protocol" v1.44 (2013), §5.
//   DMXKing ultraDMX Micro / ultraDMX2 Pro use the same packet format.
//
// ── Hardware validation status ────────────────────────────────────────────
// TODO(hardware): NOT yet tested against physical hardware.
// See docs/pending/PR_DMX_SUPPORT.md §8 for the validation checklist.
// Framing is correct per published spec. Serial port settings or
// inter-frame delay may need adjustment once a real device is available.

const ENTTEC_BAUD     = 57600;
const MSG_START       = 0x7e;
const MSG_END         = 0xe7;
const LABEL_SEND_DMX  = 0x06;
const DMX_START_CODE  = 0x00;

/**
 * Build an Enttec USB Pro label-6 packet from a DMX frame buffer.
 *
 * @param {Buffer} frameBuffer - 513-byte buffer: [0]=start-code, [1..N]=slots.
 * @returns {Buffer}           - Complete USB Pro message, ready to write.
 */
function buildPacket(frameBuffer) {
    const slotCount  = frameBuffer.length - 1;   // exclude start-code position
    const dataLength = slotCount + 1;             // start-code + slots

    // 4 header bytes + dataLength data bytes + 1 terminator
    const packet = Buffer.allocUnsafe(4 + dataLength + 1);

    packet[0] = MSG_START;
    packet[1] = LABEL_SEND_DMX;
    packet[2] = dataLength & 0xff;         // LSB
    packet[3] = (dataLength >> 8) & 0xff;  // MSB
    packet[4] = DMX_START_CODE;
    frameBuffer.copy(packet, 5, 1);        // copy slot bytes (skip frameBuffer[0])
    packet[4 + dataLength] = MSG_END;

    return packet;
}

/**
 * EnttecProInterface — Enttec DMX USB Pro / DMXKing ultraDMX Pro output.
 *
 * Unlike OpenDmxInterface (which opens/closes per frame), this holds a
 * persistent serial port connection. The device MCU handles DMX break and
 * MAB; the host writes a label-framed packet at 57600 baud 8N1.
 *
 * Lifecycle: DmxUniverse calls sendFrame() on every tick. The port is
 * opened lazily on the first call and held open. On serial error, the
 * port is cleared so the next sendFrame() call attempts re-open — the
 * DmxUniverse backoff loop then controls retry timing.
 *
 * `close()` is called by DmxUniverse on shutdown.
 */
class EnttecProInterface {
    constructor() {
        this._port    = null;
        this._path    = null;
        this._opening = null;
    }

    /**
     * Open the serial port. No-op if already open on the same path.
     * @param {string} devicePath
     */
    async open(devicePath) {
        if (this._port && this._port.isOpen && this._path === devicePath) return;

        if (this._opening) return this._opening;

        this._path    = devicePath;
        this._opening = new Promise((resolve, reject) => {
            const p = new SerialPort({
                path:     devicePath,
                baudRate: ENTTEC_BAUD,
                dataBits: 8,
                stopBits: 1,
                parity:   'none',
                autoOpen: false,
            });
            p.open((err) => {
                this._opening = null;
                if (err) { reject(err); } else { this._port = p; resolve(); }
            });
        });

        return this._opening;
    }

    /**
     * Close the serial port. Safe to call when already closed.
     */
    async close() {
        const p = this._port;
        if (!p) return;
        this._port = null;
        return new Promise((resolve, reject) => {
            p.drain((drainErr) => {
                p.close((closeErr) => (closeErr || drainErr ? reject(closeErr || drainErr) : resolve()));
            });
        });
    }

    /**
     * Send one DMX512 frame.
     *
     * Opens the port lazily on first call. On any write error the port is
     * cleared; the next call will re-open it (backoff is the caller's job).
     *
     * @param {string} devicePath  - Absolute serial device path.
     * @param {Buffer} frameBuffer - 513-byte buffer: [0]=start-code(0x00), [1..512]=slots.
     */
    async sendFrame(devicePath, frameBuffer) {
        if (!this._port || !this._port.isOpen || this._path !== devicePath) {
            await this.open(devicePath);
        }

        const packet = buildPacket(frameBuffer);

        await new Promise((resolve, reject) => {
            this._port.write(packet, (writeErr) => {
                if (writeErr) {
                    this._port = null; // force re-open on next frame
                    return reject(writeErr);
                }
                this._port.drain((drainErr) => {
                    if (drainErr) {
                        this._port = null;
                        reject(drainErr);
                    } else {
                        resolve();
                    }
                });
            });
        });
    }
}

// Inter-frame delay (ms). Set to 0 for genuine Enttec USB Pro.
// Increase to 1–4 if a clone drops frames at 30+ Hz.
// TODO(hardware): verify the correct value for your specific device.
EnttecProInterface.interFrameDelayMs = 0;

module.exports = { EnttecProInterface, buildPacket };
