'use strict';

const AdapterBase = require('../adapter-base');
const { loadProfile } = require('../dmx/profiles');

// Default maximum single-burst duration. Protects against operator error
// (e.g., sending duration_ms = 999999 to a fogger).
const DEFAULT_MAX_RUN_MS  = 4000;
const DEFAULT_STROBE_RATE = 128; // mid-speed; applies to strobe-2ch dimmer channel

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v))); }

/**
 * DmxEffectAdapter — Controls short-duration DMX effect devices.
 *
 * Supports: fogger-1ch, fogger-2ch, strobe-2ch, hazer-2ch (and any custom
 * fixture with the 'effect' capability).
 *
 * ── Command surface ──────────────────────────────────────────────────────
 *
 *   { "command": "burst",        "duration_ms": 1500 }
 *   { "command": "burst",        "duration_ms": 1500, "intensity": 80 }
 *   { "command": "pulse",        "duration_ms": 250,  "intensity": 60 }
 *   { "command": "stop" }
 *   { "command": "setIntensity", "intensity": 70 }
 *   { "command": "getStatus" }
 *
 * burst / pulse are equivalent: both fire output for `duration_ms` then stop.
 * stop   : immediately zeroes all channels; cancels any running timer.
 * setIntensity: sets the current level without starting a timer (no auto-stop).
 *
 * ── Safety ───────────────────────────────────────────────────────────────
 *
 * config.max_run_ms (default 4000): any burst/pulse with duration_ms >
 * max_run_ms is rejected with a warning. The adapter also enforces its own
 * internal stop timer so hardware is never left running if the process stays
 * alive. On dispose(), the timer is cancelled and channels are zeroed.
 *
 * ── Config keys ──────────────────────────────────────────────────────────
 *
 *   topic        {string}  — MQTT topic for this device
 *   fixture      {string}  — profile name (fogger-1ch | fogger-2ch | strobe-2ch | hazer-2ch)
 *   address      {number}  — DMX start address, 1-based (default 1)
 *   max_run_ms   {number}  — maximum allowed burst/pulse duration in ms (default 4000)
 *   intensity    {number}  — default output intensity 0–100 (default 100)
 *   strobe_rate  {number}  — strobe channel value 0–255 for strobe-2ch (default 128)
 *   fan_speed    {number}  — speed channel value 0–255 for 2-ch fogger/hazer (default 0)
 */
class DmxEffectAdapter extends AdapterBase {
    constructor({ config, mqttClient, logger, universe }) {
        super({ name: 'DmxEffectAdapter', config, mqttClient, logger });

        if (!universe) {
            throw new Error('DmxEffectAdapter: universe is required (no [dmx] section configured or dmx disabled)');
        }

        const fixtureName = (config.fixture || '').toLowerCase();
        const profile = loadProfile(fixtureName, {});

        if (!profile.capabilities.includes('effect')) {
            throw new Error(
                `DmxEffectAdapter: fixture "${fixtureName}" does not have the 'effect' capability. ` +
                `Use one of: fogger-1ch, fogger-2ch, strobe-2ch, hazer-2ch, or a custom effect fixture.`
            );
        }

        this._universe     = universe;
        this._profile      = profile;
        this._fixtureName  = fixtureName;
        this._maxRunMs     = Math.max(1, Math.round(config.max_run_ms ?? DEFAULT_MAX_RUN_MS));
        this._defaultIntensity = clamp(config.intensity ?? 100, 0, 100);
        this._strobeRate   = clamp(config.strobe_rate ?? DEFAULT_STROBE_RATE, 0, 255);
        this._fanSpeed     = clamp(config.fan_speed ?? 0, 0, 255);

        // Validate address before clamping so out-of-range values are caught.
        const rawAddress = config.address ?? 1;
        const lastSlot = rawAddress + profile.channels.length - 1;
        if (lastSlot > 512 || rawAddress < 1) {
            throw new Error(
                `DmxEffectAdapter: fixture "${fixtureName}" (${profile.channels.length} ch) at address ` +
                `${rawAddress} would end at slot ${lastSlot}, exceeding DMX 512-slot limit`
            );
        }
        this._address = rawAddress;

        // Build slot → absolute DMX address lookup (0-based offset + 1-based address).
        this._slotOffset = {};
        for (let i = 0; i < profile.channels.length; i++) {
            this._slotOffset[profile.channels[i]] = this._address + i;
        }

        this._state = {
            on:         false,
            intensity:  0,
            expires_at: null,
        };

        this._timer       = null;
        this._subscribed  = false;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    async init() {
        this._assertNotDisposed();
        this.logger.info(
            `DmxEffectAdapter: Initializing (topic: ${this.config.topic}, ` +
            `fixture: ${this._fixtureName}, address: ${this._address}, max_run_ms: ${this._maxRunMs})`
        );

        // Start in safe state: all channels zeroed.
        this._applyStop();
        this._publishState();

        await this.mqttClient.subscribe(`${this.config.topic}/commands`, (_topic, payload) => {
            this.safeCall('command', () => this._handleCommand(payload));
        });
        this._subscribed = true;

        this.logger.info(`DmxEffectAdapter: Ready (${this._fixtureName} at address ${this._address})`);
    }

    handleStateUpdate(_state) {
        // Effect devices are command-driven; no upstream radio integration.
    }

    async dispose() {
        this._assertNotDisposed();

        if (this._subscribed) {
            this.mqttClient.unsubscribe(`${this.config.topic}/commands`).catch((err) => {
                this.logger.warn(`DmxEffectAdapter: Unsubscribe error: ${err.message}`);
            });
            this._subscribed = false;
        }

        // Cancel any running burst timer and zero all channels.
        this._cancelTimer();
        this._applyStop();

        this._markDisposed();
        this.logger.info('DmxEffectAdapter: Disposed');
    }

    // ── Command dispatch ─────────────────────────────────────────────────────

    async _handleCommand(msg) {
        this._assertNotDisposed();

        let payload;
        try {
            payload = typeof msg === 'string' ? JSON.parse(msg) : msg;
        } catch {
            this.publishWarning('EFFECT_CMD_INVALID', 'Command payload must be valid JSON');
            return;
        }

        if (!payload || typeof payload !== 'object') {
            this.publishWarning('EFFECT_CMD_INVALID', 'Command payload must be a JSON object');
            return;
        }

        const action = payload.action || payload.command;

        switch (action) {
            case 'burst':
            case 'pulse':
                this._commandBurst(payload);
                break;

            case 'stop':
                this._commandStop();
                break;

            case 'setIntensity':
                this._commandSetIntensity(payload);
                break;

            case 'getStatus':
            case 'getState':
                this._publishState();
                break;

            default:
                this.publishWarning(
                    'EFFECT_CMD_UNKNOWN',
                    `Unknown command: "${action}". Supported: burst, pulse, stop, setIntensity, getStatus.`,
                    { command: action }
                );
        }
    }

    // ── Commands ─────────────────────────────────────────────────────────────

    /**
     * burst / pulse: fire output for duration_ms, then auto-stop.
     */
    _commandBurst(payload) {
        const durationMs = Math.round(Number(payload.duration_ms));
        if (!Number.isFinite(durationMs) || durationMs < 1) {
            this.publishWarning(
                'EFFECT_CMD_INVALID',
                `burst/pulse requires a positive duration_ms, got: ${payload.duration_ms}`
            );
            return;
        }

        if (durationMs > this._maxRunMs) {
            this.publishWarning(
                'EFFECT_DURATION_CAPPED',
                `Requested duration_ms ${durationMs} exceeds max_run_ms ${this._maxRunMs}. ` +
                `Command rejected. Increase [effect] max_run_ms in config to allow longer bursts.`,
                { requested_ms: durationMs, max_run_ms: this._maxRunMs }
            );
            return;
        }

        const intensity = payload.intensity !== undefined
            ? clamp(Number(payload.intensity), 0, 100)
            : this._defaultIntensity;

        // Cancel any currently running burst before starting a new one.
        this._cancelTimer();
        this._applyOutput(intensity);

        const expiresAt = new Date(Date.now() + durationMs).toISOString();
        this._state.expires_at = expiresAt;
        this._publishState();
        this.publishEvent('burst-started', { intensity, duration_ms: durationMs, expires_at: expiresAt });

        this._timer = setTimeout(() => {
            this._timer = null;
            this._applyStop();
            this._publishState();
            this.publishEvent('burst-ended', { intensity });
        }, durationMs);
    }

    /**
     * stop: immediately zero all channels and cancel any running timer.
     */
    _commandStop() {
        const wasOn = this._state.on;
        this._cancelTimer();
        this._applyStop();
        this._publishState();
        if (wasOn) {
            this.publishEvent('stopped');
        }
    }

    /**
     * setIntensity: set current output level without starting a timer.
     * The device stays at this level indefinitely until stopped or overwritten.
     */
    _commandSetIntensity(payload) {
        const intensity = clamp(Number(payload.intensity ?? 0), 0, 100);
        this._applyOutput(intensity);
        this._publishState();
        this.publishEvent('intensity-updated', { intensity });
    }

    // ── Channel helpers ──────────────────────────────────────────────────────

    /**
     * Write all channels to represent the given intensity level (0–100).
     */
    _applyOutput(intensity) {
        const dmxVal = Math.round((intensity / 100) * 255);

        // Write primary output channel (dimmer = intensity).
        if ('dimmer' in this._slotOffset) {
            this._universe.setChannel(this._slotOffset['dimmer'], dmxVal);
        }

        // For strobe fixtures, set the strobe rate when intensity > 0.
        if ('strobe' in this._slotOffset) {
            this._universe.setChannel(this._slotOffset['strobe'], intensity > 0 ? this._strobeRate : 0);
        }

        // For 2-channel devices, set secondary speed/fan channel when running.
        if ('speed' in this._slotOffset) {
            this._universe.setChannel(this._slotOffset['speed'], intensity > 0 ? this._fanSpeed : 0);
        }

        this._state.on        = intensity > 0;
        this._state.intensity = intensity;
        this._state.expires_at = this._state.expires_at ?? null;
    }

    /**
     * Zero all channels (safe state: device off).
     */
    _applyStop() {
        for (const slot of this._profile.channels) {
            if (slot in this._slotOffset) {
                this._universe.setChannel(this._slotOffset[slot], 0);
            }
        }
        this._state.on        = false;
        this._state.intensity = 0;
        this._state.expires_at = null;
    }

    /**
     * Cancel the running auto-stop timer without touching channels.
     */
    _cancelTimer() {
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
            this._state.expires_at = null;
        }
    }

    // ── State ────────────────────────────────────────────────────────────────

    _publishState() {
        this.publishState({
            on:         this._state.on,
            intensity:  this._state.intensity,
            expires_at: this._state.expires_at,
            fixture:    this._fixtureName,
            address:    this._address,
            timestamp:  new Date().toISOString(),
        });
    }
}

module.exports = DmxEffectAdapter;
