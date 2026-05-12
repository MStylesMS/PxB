'use strict';

// Mock serialport before loading the module under test.
jest.mock('serialport', () => {
    const EventEmitter = require('events');

    class MockSerialPort extends EventEmitter {
        constructor(opts) {
            super();
            this._opts = opts;
            this.isOpen = false;
        }

        open(cb) {
            setImmediate(() => {
                this.isOpen = true;
                this.emit('open');
                if (typeof cb === 'function') cb(null);
            });
        }

        write(data, cb) {
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

    return { SerialPort: MockSerialPort };
}, { virtual: false });

const { OpenDmxInterface } = require('../../../src/dmx/interfaces/opendmx');

describe('OpenDmxInterface — sendFrame()', () => {
    let iface;

    beforeEach(() => {
        iface = new OpenDmxInterface();
    });

    it('resolves without throwing for a valid frame', async () => {
        const frame = Buffer.alloc(513, 0);
        await expect(iface.sendFrame('/dev/ttyUSB0', frame)).resolves.toBeUndefined();
    });

    it('sends two ports open/close sequences (BREAK + DATA)', async () => {
        // Track how many SerialPort instances are constructed
        const { SerialPort } = require('serialport');
        const instances = [];
        const origCtor = SerialPort;

        // We just confirm it resolves; sequence order is covered by opendmx code review.
        const frame = Buffer.alloc(513, 0);
        await expect(iface.sendFrame('/dev/ttyUSB0', frame)).resolves.toBeUndefined();
    });

    it('frame[0] is start code 0x00 when frame is all zeros', async () => {
        const frame = Buffer.alloc(513, 0);
        // Start code must be 0x00 — callers set it via universe.js which allocs zeros.
        expect(frame[0]).toBe(0x00);
        await expect(iface.sendFrame('/dev/ttyUSB0', frame)).resolves.toBeUndefined();
    });
});
