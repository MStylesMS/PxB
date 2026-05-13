'use strict';

// Mock serialport before loading the module under test.
jest.mock('serialport', () => {
    const EventEmitter = require('events');

    class MockSerialPort extends EventEmitter {
        constructor(opts) {
            super();
            this.opts    = opts;
            this.isOpen  = false;
            this.written = [];
        }

        open(cb) {
            setImmediate(() => {
                this.isOpen = true;
                if (typeof cb === 'function') cb(null);
            });
        }

        write(data, cb) {
            this.written.push(Buffer.from(data));
            if (typeof cb === 'function') cb(null);
        }

        drain(cb) {
            if (typeof cb === 'function') cb(null);
        }

        close(cb) {
            this.isOpen = false;
            if (typeof cb === 'function') cb(null);
        }
    }

    let _lastPort = null;
    const ctor = jest.fn((opts) => {
        const p = new MockSerialPort(opts);
        _lastPort = p;
        return p;
    });
    ctor._last = () => _lastPort;

    return { SerialPort: ctor };
}, { virtual: false });

const { EnttecProInterface, buildPacket } = require('../../../src/dmx/interfaces/enttec-pro');
const { SerialPort }                      = require('serialport');

// ── buildPacket() unit tests (pure, no I/O) ───────────────────────────────

describe('buildPacket()', () => {
    it('starts with 0x7E', () => {
        const frame = Buffer.alloc(513, 0);
        const pkt   = buildPacket(frame);
        expect(pkt[0]).toBe(0x7e);
    });

    it('sets label byte to 0x06 (Send DMX)', () => {
        const frame = Buffer.alloc(513, 0);
        const pkt   = buildPacket(frame);
        expect(pkt[1]).toBe(0x06);
    });

    it('encodes data length as LSB/MSB for a full 512-slot universe', () => {
        // frameBuffer = 513 bytes (start-code + 512 slots)
        // dataLength  = 512 + 1 = 513  (0x201)
        const frame  = Buffer.alloc(513, 0);
        const pkt    = buildPacket(frame);
        const len    = pkt[2] | (pkt[3] << 8);
        expect(len).toBe(513);
    });

    it('encodes data length for a 24-slot universe', () => {
        // frameBuffer = 25 bytes (start-code + 24 slots)
        // dataLength  = 24 + 1 = 25
        const frame = Buffer.alloc(25, 0);
        const pkt   = buildPacket(frame);
        const len   = pkt[2] | (pkt[3] << 8);
        expect(len).toBe(25);
    });

    it('byte at offset 4 is the DMX start code 0x00', () => {
        const frame = Buffer.alloc(513, 0xAB); // fill with non-zero
        const pkt   = buildPacket(frame);
        expect(pkt[4]).toBe(0x00);
    });

    it('slot bytes start at packet offset 5', () => {
        const frame = Buffer.alloc(513, 0);
        frame[1]    = 0x42; // first real slot
        frame[2]    = 0x99; // second real slot
        const pkt   = buildPacket(frame);
        expect(pkt[5]).toBe(0x42);
        expect(pkt[6]).toBe(0x99);
    });

    it('last byte is terminator 0xE7', () => {
        const frame = Buffer.alloc(513, 0);
        const pkt   = buildPacket(frame);
        expect(pkt[pkt.length - 1]).toBe(0xe7);
    });

    it('total packet size is correct for a 512-slot frame (518 bytes)', () => {
        // 4 header + 513 data (start-code + 512 slots) + 1 terminator = 518
        const frame = Buffer.alloc(513, 0);
        const pkt   = buildPacket(frame);
        expect(pkt.length).toBe(518);
    });

    it('total packet size is correct for a 24-slot frame', () => {
        // 4 header + 25 data + 1 terminator = 30
        const frame = Buffer.alloc(25, 0);
        const pkt   = buildPacket(frame);
        expect(pkt.length).toBe(30);
    });

    it('preserves all 512 slot bytes in order', () => {
        const frame = Buffer.alloc(513, 0);
        for (let i = 1; i <= 512; i++) frame[i] = i & 0xff;
        const pkt = buildPacket(frame);
        // Slot data starts at pkt[5]
        for (let i = 0; i < 512; i++) {
            expect(pkt[5 + i]).toBe((i + 1) & 0xff);
        }
    });
});

// ── EnttecProInterface integration (mocked SerialPort) ────────────────────

describe('EnttecProInterface — sendFrame()', () => {
    beforeEach(() => {
        SerialPort.mockClear();
        EnttecProInterface.interFrameDelayMs = 0;
    });

    it('resolves without error for a valid 513-byte frame', async () => {
        const iface = new EnttecProInterface();
        const frame = Buffer.alloc(513, 0);
        await expect(iface.sendFrame('/dev/ttyUSB0', frame)).resolves.toBeUndefined();
    });

    it('opens the port at 57600 baud', async () => {
        const iface = new EnttecProInterface();
        await iface.sendFrame('/dev/ttyUSB0', Buffer.alloc(513, 0));
        expect(SerialPort).toHaveBeenCalledWith(
            expect.objectContaining({ baudRate: 57600 })
        );
    });

    it('opens the port with 8N1 settings', async () => {
        const iface = new EnttecProInterface();
        await iface.sendFrame('/dev/ttyUSB0', Buffer.alloc(513, 0));
        expect(SerialPort).toHaveBeenCalledWith(
            expect.objectContaining({ dataBits: 8, stopBits: 1, parity: 'none' })
        );
    });

    it('writes a correctly framed packet to the serial port', async () => {
        const iface = new EnttecProInterface();
        const frame = Buffer.alloc(513, 0);
        frame[1]    = 0x55; // spot check first slot
        await iface.sendFrame('/dev/ttyUSB0', frame);

        const port   = SerialPort._last();
        expect(port.written.length).toBeGreaterThan(0);
        const pkt = port.written[port.written.length - 1];
        expect(pkt[0]).toBe(0x7e);
        expect(pkt[1]).toBe(0x06);
        expect(pkt[4]).toBe(0x00);
        expect(pkt[5]).toBe(0x55);
        expect(pkt[pkt.length - 1]).toBe(0xe7);
    });

    it('reuses the same port on subsequent calls (same path)', async () => {
        const iface = new EnttecProInterface();
        await iface.sendFrame('/dev/ttyUSB0', Buffer.alloc(513, 0));
        await iface.sendFrame('/dev/ttyUSB0', Buffer.alloc(513, 0));
        // Only one SerialPort constructor call
        expect(SerialPort).toHaveBeenCalledTimes(1);
    });

    it('reopens the port if the device path changes', async () => {
        const iface = new EnttecProInterface();
        await iface.sendFrame('/dev/ttyUSB0', Buffer.alloc(513, 0));
        await iface.sendFrame('/dev/ttyUSB1', Buffer.alloc(513, 0));
        expect(SerialPort).toHaveBeenCalledTimes(2);
    });
});

// ── EnttecProInterface.close() ────────────────────────────────────────────

describe('EnttecProInterface — close()', () => {
    beforeEach(() => SerialPort.mockClear());

    it('resolves without error when not open', async () => {
        const iface = new EnttecProInterface();
        await expect(iface.close()).resolves.toBeUndefined();
    });

    it('closes the port after sendFrame()', async () => {
        const iface = new EnttecProInterface();
        await iface.sendFrame('/dev/ttyUSB0', Buffer.alloc(513, 0));
        const port = SerialPort._last();
        expect(port.isOpen).toBe(true);
        await iface.close();
        expect(port.isOpen).toBe(false);
    });
});
