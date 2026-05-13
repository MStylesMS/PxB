'use strict';

const EventEmitter = require('events');
const { DmxUniverse } = require('../../../src/dmx/universe');

/** Build a minimal mock interface that resolves immediately. */
function mockIface({ shouldFail = false, failAfter = Infinity } = {}) {
    let callCount = 0;
    return {
        calls: [],
        get callCount() { return callCount; },
        sendFrame(port, frame) {
            callCount++;
            this.calls.push({ port, frame: Buffer.from(frame) });
            if (callCount > failAfter || shouldFail) {
                return Promise.reject(new Error('mock serial error'));
            }
            return Promise.resolve();
        },
    };
}

describe('DmxUniverse — constructor', () => {
    it('throws if port is omitted', () => {
        expect(() => new DmxUniverse({})).toThrow('port is required');
    });

    it('defaults interface to opendmx', () => {
        const u = new DmxUniverse({ port: '/dev/fake', iface: mockIface() });
        expect(u.getStatus().interface).toBe('opendmx');
    });

    it('clamps refresh_hz to 1–44', () => {
        const low = new DmxUniverse({ port: '/dev/fake', refresh_hz: 0,  iface: mockIface() });
        const hi  = new DmxUniverse({ port: '/dev/fake', refresh_hz: 99, iface: mockIface() });
        expect(low.getStatus().refresh_hz).toBe(1);
        expect(hi.getStatus().refresh_hz).toBe(44);
    });

    it('clamps universe_size to 24–512', () => {
        const small = new DmxUniverse({ port: '/dev/fake', universe_size: 1,   iface: mockIface() });
        const large = new DmxUniverse({ port: '/dev/fake', universe_size: 600, iface: mockIface() });
        expect(small.getStatus().universe_size).toBe(24);
        expect(large.getStatus().universe_size).toBe(512);
    });

    it('starts in stopped state', () => {
        const u = new DmxUniverse({ port: '/dev/fake', iface: mockIface() });
        expect(u.state).toBe('stopped');
        expect(u.connected).toBe(false);
    });
});

describe('DmxUniverse — setChannel', () => {
    let u;
    beforeEach(() => {
        u = new DmxUniverse({ port: '/dev/fake', universe_size: 512, iface: mockIface() });
    });

    it('sets 1-based channel correctly', () => {
        u.setChannel(1, 200);
        expect(u._frame[1]).toBe(200);
    });

    it('frame[0] stays 0x00 (start code)', () => {
        u.setChannel(1, 255);
        expect(u._frame[0]).toBe(0);
    });

    it('clamps value below 0 to 0', () => {
        u.setChannel(5, -1);
        expect(u._frame[5]).toBe(0);
    });

    it('clamps value above 255 to 255', () => {
        u.setChannel(5, 300);
        expect(u._frame[5]).toBe(255);
    });

    it('ignores channel 0 (out of range)', () => {
        const before = Buffer.from(u._frame);
        u.setChannel(0, 128);
        expect(u._frame).toEqual(before);
    });

    it('ignores channel > universe_size', () => {
        const before = Buffer.from(u._frame);
        u.setChannel(513, 128);
        expect(u._frame).toEqual(before);
    });

    it('rounds float values', () => {
        u.setChannel(3, 127.9);
        expect(u._frame[3]).toBe(128);
    });
});

describe('DmxUniverse — setChannels', () => {
    it('sets multiple channels via map', () => {
        const u = new DmxUniverse({ port: '/dev/fake', iface: mockIface() });
        u.setChannels({ 1: 10, 2: 20, 3: 30 });
        expect(u._frame[1]).toBe(10);
        expect(u._frame[2]).toBe(20);
        expect(u._frame[3]).toBe(30);
    });
});

describe('DmxUniverse — blackout', () => {
    it('zeros data slots but preserves start code', () => {
        const u = new DmxUniverse({ port: '/dev/fake', iface: mockIface() });
        u.setChannel(1, 200);
        u.setChannel(100, 100);
        u.blackout();
        expect(u._frame[0]).toBe(0);
        expect(u._frame[1]).toBe(0);
        expect(u._frame[100]).toBe(0);
    });
});

describe('DmxUniverse — getStatus', () => {
    it('returns expected shape', () => {
        const u = new DmxUniverse({ port: '/dev/ttyUSB0', refresh_hz: 25, universe_size: 100, iface: mockIface() });
        const s = u.getStatus();
        expect(s).toMatchObject({
            enabled:       true,
            connected:     false,
            port:          '/dev/ttyUSB0',
            interface:     'opendmx',
            refresh_hz:    25,
            universe_size: 100,
            frame_count:   0,
            state:         'stopped',
        });
        expect(s.last_frame_ts).toBeNull();
        expect(s.last_error).toBeNull();
    });
});

describe('DmxUniverse — start()', () => {
    it('rejects if called twice without stopping', async () => {
        const iface = mockIface();
        const u = new DmxUniverse({ port: '/dev/fake', iface, backoffMinMs: 9999 });
        // Stub fs.existsSync so the port appears to exist
        jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
        await u.start();
        await expect(u.start()).rejects.toThrow(/"starting"|"connected"/);
        u._shuttingDown = true;
        u._clearTimers();
        require('fs').existsSync.mockRestore();
    });

    it('emits connected and transitions to connected state on success', async () => {
        const iface = mockIface();
        const u = new DmxUniverse({ port: '/dev/fake', iface, backoffMinMs: 9999 });
        jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
        const connected = new Promise((res) => u.once('connected', res));
        await u.start();
        await connected;
        expect(u.state).toBe('connected');
        expect(u.connected).toBe(true);
        u._shuttingDown = true;
        u._clearTimers();
        require('fs').existsSync.mockRestore();
    });

    it('schedules reconnect if port not found', async () => {
        const iface = mockIface();
        const u = new DmxUniverse({ port: '/dev/fake', iface, backoffMinMs: 9999 });
        jest.spyOn(require('fs'), 'existsSync').mockReturnValue(false);
        const warned = new Promise((res) => u.once('warning', res));
        await u.start();
        const w = await warned;
        expect(w.code).toBe('DMX_PORT_NOT_FOUND');
        expect(u.state).toBe('error');
        u._shuttingDown = true;
        u._clearTimers();
        require('fs').existsSync.mockRestore();
    });

    it('sends frames at each tick (integration)', async () => {
        const iface = mockIface();
        // Use 44 Hz so ticks come in fast
        const u = new DmxUniverse({ port: '/dev/fake', iface, refresh_hz: 44, backoffMinMs: 9999 });
        jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
        await u.start();
        // Wait for a few extra ticks (~100 ms at 44 Hz = ~4 frames + probe = 5+)
        await new Promise((r) => setTimeout(r, 100));
        expect(iface.callCount).toBeGreaterThanOrEqual(2);
        u._shuttingDown = true;
        u._clearTimers();
        require('fs').existsSync.mockRestore();
    });
});

describe('DmxUniverse — dispose()', () => {
    it('sends blackout frame and stops loop', async () => {
        const iface = mockIface();
        const u = new DmxUniverse({ port: '/dev/fake', iface, backoffMinMs: 9999 });
        jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
        await u.start();
        u.setChannel(1, 200);
        await u.dispose();
        // The last call to sendFrame must have a zeroed data slot
        const lastFrame = iface.calls[iface.calls.length - 1].frame;
        expect(lastFrame[1]).toBe(0);
        expect(u.state).toBe('stopped');
        require('fs').existsSync.mockRestore();
    });
});

describe('DmxUniverse — state-changed event', () => {
    it('fires on each state transition', async () => {
        const iface = mockIface();
        const u = new DmxUniverse({ port: '/dev/fake', iface, backoffMinMs: 9999 });
        jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
        const states = [];
        u.on('state-changed', (s) => states.push(s));
        await u.start();
        expect(states).toContain('starting');
        expect(states).toContain('connected');
        u._shuttingDown = true;
        u._clearTimers();
        require('fs').existsSync.mockRestore();
    });
});

// ── Master blackout ───────────────────────────────────────────────────────

describe('DmxUniverse — masterBlackout / masterRestore', () => {
    let u, iface;

    beforeEach(async () => {
        iface = mockIface();
        u = new DmxUniverse({ port: '/dev/fake', iface, backoffMinMs: 9999 });
        jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
        await u.start();
    });

    afterEach(() => {
        u._shuttingDown = true;
        u._clearTimers();
        require('fs').existsSync.mockRestore();
    });

    it('masterBlackout causes wire frame to be all-zero', async () => {
        u.setChannel(1, 200);
        u.masterBlackout();

        // Wait for next tick
        await new Promise((r) => setTimeout(r, 60));

        const lastFrame = iface.calls[iface.calls.length - 1].frame;
        expect(lastFrame[1]).toBe(0);
    });

    it('adapters can still write to _frame during blackout', () => {
        u.masterBlackout();
        u.setChannel(5, 180);
        expect(u._frame[5]).toBe(180);  // internal buffer updated
    });

    it('masterRestore sends the live frame to the wire', async () => {
        u.setChannel(1, 200);
        u.masterBlackout();
        await new Promise((r) => setTimeout(r, 60));

        // Verify blackout wire
        const duringBlackout = iface.calls[iface.calls.length - 1].frame;
        expect(duringBlackout[1]).toBe(0);

        u.masterRestore();
        await new Promise((r) => setTimeout(r, 60));

        const afterRestore = iface.calls[iface.calls.length - 1].frame;
        expect(afterRestore[1]).toBe(200);
    });

    it('getStatus reports master_blackout field', () => {
        expect(u.getStatus().master_blackout).toBe(false);
        u.masterBlackout();
        expect(u.getStatus().master_blackout).toBe(true);
        u.masterRestore();
        expect(u.getStatus().master_blackout).toBe(false);
    });

    it('emits state-changed when blackout toggled', () => {
        const events = [];
        u.on('state-changed', () => events.push(1));
        u.masterBlackout();
        u.masterRestore();
        expect(events).toHaveLength(2);
    });
});

// ── Recording ────────────────────────────────────────────────────────────

describe('DmxUniverse — recording and playback', () => {
    let u, iface;

    beforeEach(async () => {
        iface = mockIface();
        u = new DmxUniverse({ port: '/dev/fake', iface, backoffMinMs: 9999, refresh_hz: 44 });
        jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
        await u.start();
    });

    afterEach(() => {
        u._shuttingDown = true;
        u._clearTimers();
        require('fs').existsSync.mockRestore();
    });

    it('startRecording clears buffer and sets recording flag', () => {
        u.startRecording();
        expect(u._recording).toBe(true);
        expect(u._recordingBuffer).toHaveLength(0);
    });

    it('stopRecording returns the buffer and clears flag', async () => {
        u.startRecording();
        u.setChannel(1, 100);
        await new Promise((r) => setTimeout(r, 80));   // let some ticks fire
        const frames = u.stopRecording();
        expect(u._recording).toBe(false);
        expect(Array.isArray(frames)).toBe(true);
        expect(frames.length).toBeGreaterThan(0);
        frames.forEach((f) => {
            expect(typeof f.deltaMs).toBe('number');
            expect(Buffer.isBuffer(f.frame)).toBe(true);
        });
    });

    it('playRecording restores frame snapshots', async () => {
        // Build a 2-frame recording manually (skip serial I/O timing)
        u._recordingBuffer = [
            { deltaMs: 0,  frame: Buffer.from([0, 200, 0, 0, 0]) },
            { deltaMs: 10, frame: Buffer.from([0, 50,  0, 0, 0]) },
        ];

        u.playRecording(false);

        // After 0ms the first frame should be written (deltaMs=0)
        await new Promise((r) => setTimeout(r, 20));
        // After 20ms the second frame (deltaMs=10) should be written
        await new Promise((r) => setTimeout(r, 15));
        expect(u._frame[1]).toBe(50);
    });

    it('stopPlayback halts sequence and no further frames written', async () => {
        u._recordingBuffer = [
            { deltaMs: 0,   frame: Buffer.from([0, 200, 0, 0, 0]) },
            { deltaMs: 500, frame: Buffer.from([0, 99,  0, 0, 0]) },
        ];

        u.playRecording(false);
        await new Promise((r) => setTimeout(r, 5));   // first frame applied
        u.stopPlayback();
        expect(u._playbackTimer).toBeNull();

        await new Promise((r) => setTimeout(r, 600));  // second frame would fire here
        expect(u._frame[1]).not.toBe(99);
    });

    it('getStatus reports recording and playback_active fields', () => {
        expect(u.getStatus().recording).toBe(false);
        expect(u.getStatus().playback_active).toBe(false);
        u.startRecording();
        expect(u.getStatus().recording).toBe(true);
    });
});
