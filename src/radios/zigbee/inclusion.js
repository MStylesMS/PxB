'use strict';

const EventEmitter = require('events');
const logger = require('../../util/logger');

/**
 * ZigbeeInclusion — pairing FSM for Zigbee.
 *
 * Zigbee doesn't have a separate "exclusion" inclusion-mode like Z-Wave; devices
 * leave via a local factory-reset or a targeted `removeDevice` call. The FSM
 * here therefore only manages an *inclusion* window opened via herdsman's
 * `permitJoin()`, and exposes a force-leave path (used by the bridge command
 * handler's `removeFailedNode` for zigbee nodes).
 *
 * States: idle | including
 *
 * Events emitted:
 *   'state-changed' (newState, prevState)
 *   'included'   ({ ieee, modelId, manufacturerName })
 *   'excluded'   ({ ieee })
 *   'timeout'    ({ mode: 'inclusion' })
 *   'warning'    ({ severity, code, message, context })
 */
class ZigbeeInclusion extends EventEmitter {
    /**
     * @param {object} opts
     * @param {import('./driver').ZigbeeDriver} opts.zigbeeDriver
     * @param {number} [opts.defaultTimeoutMs=60000]
     */
    constructor({ zigbeeDriver, defaultTimeoutMs = 60_000 }) {
        super();
        this._driver = zigbeeDriver;
        this._defaultTimeoutMs = defaultTimeoutMs;
        this._state = 'idle';
        this._startedAt = null;
        this._mode = null;
        this._timeoutMs = null;
        this._timer = null;

        this._driver.on('zigbee-device-joined', (info) => {
            if (this._mode === 'inclusion') this.emit('included', info);
        });
        this._driver.on('zigbee-device-left', ({ ieee }) => {
            this.emit('excluded', { ieee });
        });
        this._driver.on('zigbee-permit-join-changed', ({ permitted }) => {
            if (!permitted && this._state === 'including') this._finalize();
        });
    }

    get state() { return this._state; }

    getStatus() {
        return {
            active: this._state !== 'idle',
            radio: this._state === 'idle' ? null : 'zigbee',
            mode: this._mode,
            started_at: this._startedAt,
            timeout_ms: this._timeoutMs,
        };
    }

    async startInclusion(opts = {}) {
        return this._begin('inclusion', opts.timeoutMs);
    }

    async stopInclusion() {
        return this._stop('inclusion');
    }

    /** Zigbee has no start/stopExclusion — calls return false + warning. */
    async startExclusion() {
        this.emit('warning', {
            severity: 'warn',
            code: 'ZIGBEE_NO_EXCLUSION_MODE',
            message: 'Zigbee has no exclusion window — use removeFailedNode to evict a specific device',
            context: {},
        });
        return false;
    }

    async stopExclusion() { return true; }

    async _begin(mode, timeoutMs) {
        if (this._state !== 'idle') {
            this.emit('warning', {
                severity: 'warn',
                code: 'INCLUSION_BUSY',
                message: `Already in ${this._state}`,
                context: { mode, current_state: this._state, radio: 'zigbee' },
            });
            return false;
        }
        const controller = this._driver.controller;
        if (!controller) {
            this.emit('warning', {
                severity: 'error',
                code: 'ZIGBEE_NOT_READY',
                message: `Cannot start ${mode}: Zigbee coordinator not connected`,
                context: { mode },
            });
            return false;
        }

        const effectiveTimeout = timeoutMs || this._defaultTimeoutMs;
        try {
            // herdsman permitJoin signature varies across versions; pass seconds
            // as last arg and accept either (time) or (permit, device, time).
            const seconds = Math.round(effectiveTimeout / 1000);
            if (controller.permitJoin.length >= 3) {
                await controller.permitJoin(true, undefined, seconds);
            } else {
                await controller.permitJoin(seconds);
            }
        } catch (err) {
            this.emit('warning', {
                severity: 'error',
                code: 'INCLUSION_START_FAILED',
                message: err?.message || String(err),
                context: { mode, radio: 'zigbee' },
            });
            return false;
        }

        this._setState('including', mode, effectiveTimeout);
        return true;
    }

    async _stop(mode) {
        if (this._state === 'idle') return true;
        const controller = this._driver.controller;
        if (!controller) return false;
        try {
            if (controller.permitJoin.length >= 3) {
                await controller.permitJoin(false);
            } else {
                await controller.permitJoin(0);
            }
        } catch (err) {
            this.emit('warning', {
                severity: 'warn',
                code: 'INCLUSION_STOP_FAILED',
                message: err?.message || String(err),
                context: { mode, radio: 'zigbee' },
            });
        }
        this._finalize();
        return true;
    }

    _setState(newState, mode, timeoutMs) {
        const prev = this._state;
        this._state = newState;
        this._mode = mode;
        this._startedAt = new Date().toISOString();
        this._timeoutMs = timeoutMs;

        if (this._timer) clearTimeout(this._timer);
        if (timeoutMs && newState !== 'idle') {
            this._timer = setTimeout(() => this._onTimeout(), timeoutMs);
            if (typeof this._timer.unref === 'function') this._timer.unref();
        }
        logger.info(`Zigbee inclusion FSM: ${prev} → ${newState}${mode ? ` (${mode})` : ''}`);
        this.emit('state-changed', newState, prev);
    }

    _finalize() {
        if (this._state === 'idle') return;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        const prev = this._state;
        this._state = 'idle';
        this._mode = null;
        this._startedAt = null;
        this._timeoutMs = null;
        logger.info(`Zigbee inclusion FSM: ${prev} → idle`);
        this.emit('state-changed', 'idle', prev);
    }

    _onTimeout() {
        const mode = this._mode;
        logger.warn(`Zigbee inclusion FSM: ${mode} timeout reached`);
        this.emit('timeout', { mode });
        this.emit('warning', {
            severity: 'warn',
            code: 'INCLUSION_TIMEOUT',
            message: `${mode} timed out after ${this._timeoutMs}ms`,
            context: { mode, timeout_ms: this._timeoutMs, radio: 'zigbee' },
        });
        this._stop(mode).catch(() => { /* reported */ });
    }
}

module.exports = { ZigbeeInclusion };
