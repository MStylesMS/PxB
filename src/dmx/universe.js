'use strict';

const fs           = require('fs');
const EventEmitter = require('events');
const logger       = require('../util/logger');
const { createInterface } = require('./interfaces');

const MIN_REFRESH_HZ     = 1;
const MAX_REFRESH_HZ     = 44;
const DEFAULT_REFRESH_HZ = 30;
const MIN_UNIVERSE_SIZE  = 24;
const MAX_UNIVERSE_SIZE  = 512;

/**
 * DmxUniverse — owns one DMX512 universe and emits frames continuously.
 *
 * Responsibilities:
 *   - Maintain a 513-byte frame buffer (byte 0 = start code 0x00, bytes 1..512 = slots).
 *   - Drive the configured interface at the configured refresh rate.
 *   - Survive serial errors with exponential-backoff reconnect (same pattern as ZWaveDriver).
 *   - Expose `setChannel / setChannels / blackout` for callers.
 *   - Expose `getStatus()` for the bridge heartbeat.
 *
 * Events:
 *   'connected'     — first frame sent successfully (or recovered after error)
 *   'disconnected'  — serial error; reconnect scheduled
 *   'warning'       — { severity, code, message, context } for MQTT publish
 *   'state-changed' — one of: stopped | starting | connected | error
 */
class DmxUniverse extends EventEmitter {
    /**
     * @param {object}  opts
     * @param {string}  opts.port           - Serial device path
     * @param {string}  [opts.interface]    - 'opendmx' (default) | 'enttec-pro'
     * @param {number}  [opts.refresh_hz]   - Target frame rate (1–44). Default 30.
     * @param {number}  [opts.universe_size] - Slot count (24–512). Default 512.
     * @param {number}  [opts.backoffMinMs] - Minimum reconnect delay. Default 1000.
     * @param {number}  [opts.backoffMaxMs] - Maximum reconnect delay. Default 30000.
     * @param {object}  [opts.iface]        - Injectable interface for tests.
     */
    constructor(opts) {
        super();
        if (!opts || !opts.port) throw new Error('DmxUniverse: port is required');

        this._port          = opts.port;
        this._interfaceName = opts.interface || 'opendmx';
        this._refreshHz     = Math.max(MIN_REFRESH_HZ, Math.min(MAX_REFRESH_HZ, opts.refresh_hz ?? DEFAULT_REFRESH_HZ));
        this._universeSize  = Math.max(MIN_UNIVERSE_SIZE, Math.min(MAX_UNIVERSE_SIZE, opts.universe_size ?? MAX_UNIVERSE_SIZE));

        // 513-byte frame: [0] = start code 0x00, [1..universeSize] = data slots
        this._frame = Buffer.alloc(this._universeSize + 1, 0);

        // Allow test injection; otherwise create from factory
        this._iface = opts.iface || createInterface(this._interfaceName);

        this._state         = 'stopped'; // stopped | starting | connected | error
        this._frameCount    = 0;
        this._lastFrameTs   = null;
        this._lastError     = null;
        this._shuttingDown  = false;
        this._sending       = false;
        this._loopTimer     = null;
        this._reconnectTimer = null;

        this._backoffMinMs  = opts.backoffMinMs ?? 1000;
        this._backoffMaxMs  = opts.backoffMaxMs ?? 30_000;
        this._currentBackoff = this._backoffMinMs;

        // Master blackout: when active, the wire frame is all-zero but _frame is
        // still updated by adapters so restore is instant.
        this._masterBlackedOut = false;

        // Recording: captures frame snapshots at each transmission tick.
        this._recording = false;
        this._recordingBuffer = [];  // [{deltaMs, frame: Buffer}]
        this._recordingStartTime = null;
        this._lastRecordedFrame  = null;
        this._lastRecordMs       = null;

        // Playback
        this._playbackTimer   = null;
        this._playbackIndex   = 0;
        this._playbackLoop    = false;
        this._inPlayback      = false;
    }

    get state()     { return this._state; }
    get connected() { return this._state === 'connected'; }
    get lastError() { return this._lastError; }

    // ── Channel API ────────────────────────────────────────────────────────────

    /**
     * Set a single DMX channel (1-based, inclusive). Value clamped 0–255.
     * @param {number} channel  1..universe_size
     * @param {number} value    0..255
     */
    setChannel(channel, value) {
        const idx = parseInt(channel, 10);
        if (idx < 1 || idx > this._universeSize) return;
        this._frame[idx] = Math.max(0, Math.min(255, Math.round(value))) & 0xff;
    }

    /**
     * Set multiple channels in one call.
     * @param {{ [channel: string|number]: number }} map
     */
    setChannels(map) {
        for (const [ch, val] of Object.entries(map)) {
            this.setChannel(ch, val);
        }
    }

    /**
     * Zero all data slots. The frame continues transmitting (silence is valid DMX).
     */
    blackout() {
        this._frame.fill(0, 1);
    }

    // ── Status ─────────────────────────────────────────────────────────────────

    getStatus() {
        return {
            enabled:           true,
            connected:         this.connected,
            port:              this._port,
            interface:         this._interfaceName,
            refresh_hz:        this._refreshHz,
            universe_size:     this._universeSize,
            last_frame_ts:     this._lastFrameTs,
            frame_count:       this._frameCount,
            last_error:        this._lastError,
            state:             this._state,
            master_blackout:   this._masterBlackedOut,
            recording:         this._recording,
            recording_frames:  this._recordingBuffer.length,
            playback_active:   this._playbackTimer !== null,
        };
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    /**
     * Start the frame loop. Resolves after the first successful frame send,
     * or immediately schedules a reconnect on serial error (does not reject).
     */
    async start() {
        if (this._state !== 'stopped') {
            throw new Error(`DmxUniverse.start() called in state "${this._state}"`);
        }
        this._shuttingDown = false;
        this._setState('starting');

        // Verify the device node exists before attempting to open
        if (!fs.existsSync(this._port)) {
            const err = new Error(`DMX serial port not found: ${this._port}`);
            this._onError(err, 'DMX_PORT_NOT_FOUND');
            this._scheduleReconnect();
            return;
        }

        // Probe: send one frame to confirm the port is writable
        try {
            await this._iface.sendFrame(this._port, this._frame);
            this._onFrameSuccess();
            this._setState('connected');
            this.emit('connected');
            logger.info(`DMX universe connected — ${this._port} (${this._interfaceName}, ${this._refreshHz} Hz target)`);
        } catch (err) {
            this._onError(err, 'DMX_PROBE_FAILED');
            this._scheduleReconnect();
            return;
        }

        this._startLoop();
    }

    /**
     * Graceful shutdown — sends one all-zero frame as a courtesy, then stops the loop.
     */
    async dispose() {
        this._shuttingDown = true;
        this._clearTimers();

        this.blackout();
        try {
            await this._iface.sendFrame(this._port, this._frame);
        } catch { /* ignore — port may be gone */ }

        this.stopPlayback();
        this._setState('stopped');
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    _startLoop() {
        const intervalMs = Math.floor(1000 / this._refreshHz);

        const tick = async () => {
            if (this._shuttingDown) return;

            if (this._sending) {
                // Previous frame still in flight — skip this tick to avoid serial contention
                this._scheduleNextTick(intervalMs, tick);
                return;
            }

            this._sending = true;
            try {
                const wireFrame = this._masterBlackedOut
                    ? Buffer.alloc(this._universeSize + 1, 0)
                    : this._frame;
                await this._iface.sendFrame(this._port, wireFrame);
                this._onFrameSuccess();
                this._recordFrameIfNeeded();

                if (this._state === 'error') {
                    // Recovered
                    this._currentBackoff = this._backoffMinMs;
                    this._setState('connected');
                    this.emit('connected');
                }
            } catch (err) {
                this._sending = false;
                this._onError(err, 'DMX_FRAME_ERROR');
                this._scheduleReconnect();
                return;
            }
            this._sending = false;

            if (!this._shuttingDown) {
                this._scheduleNextTick(intervalMs, tick);
            }
        };

        this._scheduleNextTick(intervalMs, tick);
    }

    _scheduleNextTick(intervalMs, tick) {
        this._loopTimer = setTimeout(tick, intervalMs);
        if (typeof this._loopTimer.unref === 'function') this._loopTimer.unref();
    }

    _onFrameSuccess() {
        this._frameCount++;
        this._lastFrameTs = new Date().toISOString();
        this._lastError   = null;
    }

    _onError(err, code) {
        this._lastError = err?.message || String(err);
        logger.error(`DMX [${code}]: ${this._lastError}`);
        this.emit('warning', {
            severity: 'error',
            code:     code || 'DMX_ERROR',
            message:  this._lastError,
            context:  { port: this._port },
        });
        this._setState('error');
        this.emit('disconnected');
        this._clearTimers();
    }

    _scheduleReconnect() {
        if (this._shuttingDown || this._reconnectTimer) return;

        const delay = this._currentBackoff;
        logger.warn(`DMX reconnect scheduled in ${delay}ms`);
        this.emit('warning', {
            severity: 'warn',
            code:     'DMX_RECONNECT_SCHEDULED',
            message:  `DMX reconnect in ${delay}ms`,
            context:  { port: this._port, backoff_ms: delay },
        });

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._currentBackoff = Math.min(this._currentBackoff * 2, this._backoffMaxMs);
            this._setState('stopped');
            this.start().catch(() => { /* start() handles its own failures */ });
        }, delay);

        if (typeof this._reconnectTimer.unref === 'function') this._reconnectTimer.unref();
    }

    _clearTimers() {
        if (this._loopTimer)      { clearTimeout(this._loopTimer);       this._loopTimer      = null; }
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer);  this._reconnectTimer = null; }
        if (this._playbackTimer)  { clearTimeout(this._playbackTimer);   this._playbackTimer  = null; }
    }

    // ── Master blackout ────────────────────────────────────────────────────────────────

    /**
     * Black out the wire without disturbing the logic frame. Adapters continue
     * writing to the internal buffer; `masterRestore()` immediately applies those
     * values to the wire.
     */
    masterBlackout() {
        this._masterBlackedOut = true;
        this.emit('state-changed');
        logger.debug('DmxUniverse: master blackout active');
    }

    /** Lift the master blackout — the current logic frame resumes on the wire. */
    masterRestore() {
        this._masterBlackedOut = false;
        this.emit('state-changed');
        logger.debug('DmxUniverse: master blackout cleared');
    }

    // ── Recording ─────────────────────────────────────────────────────────────────────

    /**
     * Begin capturing frame snapshots at each transmission tick.
     * Only frames that differ from the previous captured frame are stored
     * (same-frame runs are stored as a single delta-Ms entry with the updated
     * timestamp so the pause is replayed correctly).
     */
    startRecording() {
        this._recordingBuffer    = [];
        this._lastRecordedFrame  = null;
        this._lastRecordMs       = Date.now();
        this._recording          = true;
        logger.debug('DmxUniverse: recording started');
    }

    /**
     * Stop recording and return the captured frame array.
     * @returns {{deltaMs: number, frame: Buffer}[]}
     */
    stopRecording() {
        this._recording = false;
        logger.debug(`DmxUniverse: recording stopped — ${this._recordingBuffer.length} frames`);
        return this._recordingBuffer;
    }

    /**
     * Play back the recorded frame sequence.
     * @param {boolean} [loop=false]  When true, loops indefinitely until stopPlayback().
     */
    playRecording(loop = false) {
        this.stopPlayback();
        if (!this._recordingBuffer.length) {
            logger.warn('DmxUniverse: playRecording called but recording buffer is empty');
            return;
        }
        this._playbackLoop = loop;
        this._playbackIndex = 0;
        this._schedulePlaybackStep();
    }

    /** Stop any active playback immediately. */
    stopPlayback() {
        if (this._playbackTimer) {
            clearTimeout(this._playbackTimer);
            this._playbackTimer = null;
        }
        this._playbackIndex = 0;
        this._playbackLoop  = false;
    }

    _schedulePlaybackStep() {
        const entry = this._recordingBuffer[this._playbackIndex];
        if (!entry) {
            if (this._playbackLoop) {
                this._playbackIndex = 0;
                this._schedulePlaybackStep();
            } else {
                this._playbackTimer = null;
            }
            return;
        }
        this._playbackTimer = setTimeout(() => {
            if (!this._playbackTimer) return; // cancelled
            this._inPlayback = true;
            entry.frame.copy(this._frame, 0);
            this._inPlayback = false;
            this._playbackIndex++;
            this._schedulePlaybackStep();
        }, entry.deltaMs);
        if (typeof this._playbackTimer.unref === 'function') this._playbackTimer.unref();
    }

    _recordFrameIfNeeded() {
        if (!this._recording || this._inPlayback) return;

        const now = Date.now();
        const deltaMs = Math.max(0, now - (this._lastRecordMs ?? now));
        this._lastRecordMs = now;

        // Only push a new entry when the frame content actually changed
        if (!this._lastRecordedFrame || !this._frame.equals(this._lastRecordedFrame)) {
            this._lastRecordedFrame = Buffer.from(this._frame);
            this._recordingBuffer.push({ deltaMs, frame: Buffer.from(this._frame) });
        }
    }

    _setState(next) {
        if (this._state === next) return;
        const prev = this._state;
        this._state = next;
        logger.debug(`DMX state ${prev} → ${next}`);
        this.emit('state-changed', next, prev);
    }
}

module.exports = { DmxUniverse };
