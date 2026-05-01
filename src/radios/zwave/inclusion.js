'use strict';

const EventEmitter = require('events');
const logger = require('../../util/logger');

/**
 * ZWaveInclusion — finite-state machine for pairing and unpairing Z-Wave devices.
 *
 * States: idle | including | excluding
 *
 * Responsibilities:
 *   - Translate MQTT start/stop commands into `controller.beginInclusion()` /
 *     `beginExclusion()` calls with a sane default strategy.
 *   - Arm a timeout; if it elapses with no result, call stopInclusion/stopExclusion
 *     and emit a TIMEOUT warning.
 *   - Surface current state for the heartbeat `pzb/state.inclusion` block.
 *
 * Events emitted:
 *   'state-changed' (newState, prevState)
 *   'included'   ({ nodeId, ... })
 *   'excluded'   ({ nodeId })
 *   'timeout'    ({ mode: 'inclusion' | 'exclusion' })
 *   'warning'    ({ severity, code, message, context })
 */
class ZWaveInclusion extends EventEmitter {
    /**
     * @param {object} opts
     * @param {import('./driver').ZWaveDriver} opts.zwaveDriver
     * @param {number} [opts.defaultTimeoutMs=60000]
     */
    constructor({ zwaveDriver, defaultTimeoutMs = 60_000 }) {
        super();
        this._driver = zwaveDriver;
        this._defaultTimeoutMs = defaultTimeoutMs;
        this._state = 'idle';
        this._startedAt = null;
        this._mode = null; // 'inclusion' | 'exclusion' | null
        this._timeoutMs = null;
        this._timer = null;

        // Controller-level events (re-emitted by ZWaveDriver)
        this._driver.on('inclusion-started', () => this._onModeStarted('inclusion'));
        this._driver.on('exclusion-started', () => this._onModeStarted('exclusion'));
        this._driver.on('inclusion-stopped', () => this._onModeStopped('inclusion'));
        this._driver.on('exclusion-stopped', () => this._onModeStopped('exclusion'));
        this._driver.on('inclusion-failed', () => this._onModeFailed('inclusion'));
        this._driver.on('exclusion-failed', () => this._onModeFailed('exclusion'));

        this._driver.on('zwave-node-added', (info) => {
            if (this._mode === 'inclusion') {
                this.emit('included', info);
            }
        });
        this._driver.on('zwave-node-removed', ({ nodeId }) => {
            if (this._mode === 'exclusion') {
                this.emit('excluded', { nodeId });
            }
        });
    }

    get state() { return this._state; }

    /** Snapshot for the heartbeat status payload. */
    getStatus() {
        return {
            active: this._state !== 'idle',
            radio: this._state === 'idle' ? null : 'zwave',
            mode: this._mode,
            started_at: this._startedAt,
            timeout_ms: this._timeoutMs,
        };
    }

    /**
     * Begin inclusion. Returns true if command was accepted.
     * @param {object} [opts]
     * @param {number} [opts.timeoutMs]
     */
    async startInclusion(opts = {}) {
        return this._begin('inclusion', opts.timeoutMs, opts.strategy);
    }

    async startExclusion(opts = {}) {
        return this._begin('exclusion', opts.timeoutMs);
    }

    async stopInclusion() {
        return this._stop('inclusion');
    }

    async stopExclusion() {
        return this._stop('exclusion');
    }

    async _begin(mode, timeoutMs, strategy) {
        if (this._state !== 'idle') {
            logger.warn(`Inclusion: cannot start ${mode} — already ${this._state}`);
            this.emit('warning', {
                severity: 'warn',
                code: 'INCLUSION_BUSY',
                message: `Already in ${this._state}`,
                context: { mode, current_state: this._state },
            });
            return false;
        }
        const controller = this._driver.controller;
        if (!controller) {
            this.emit('warning', {
                severity: 'error',
                code: 'ZWAVE_NOT_READY',
                message: `Cannot start ${mode}: Z-Wave driver not connected`,
                context: { mode },
            });
            return false;
        }

        const effectiveTimeout = timeoutMs || this._defaultTimeoutMs;
        try {
            // InclusionStrategy: 0=Default (prefers S2), 2=Insecure, 3=S0, 4=S2.
            // We default to Insecure (2) because S2 bootstrap requires
            // `inclusionUserCallbacks` (grantSecurityClasses, validateDSKAndEnterPIN,
            // abort) which PxB does not yet wire up — without them zwave-js aborts
            // S2 and the node is left half-included and unreachable.
            // Caller may override via MQTT payload { "strategy": 4 } once callbacks are added.
            if (mode === 'inclusion') {
                const strat = Number.isInteger(strategy) ? strategy : 2;
                await controller.beginInclusion({ strategy: strat });
            } else {
                await controller.beginExclusion();
            }
        } catch (err) {
            this.emit('warning', {
                severity: 'error',
                code: mode === 'inclusion' ? 'INCLUSION_START_FAILED' : 'EXCLUSION_START_FAILED',
                message: err?.message || String(err),
                context: { mode },
            });
            return false;
        }

        // Synchronous state transition; controller may emit '…-started' later and we
        // de-duplicate in _onModeStarted.
        this._setState(mode === 'inclusion' ? 'including' : 'excluding', mode, effectiveTimeout);
        return true;
    }

    async _stop(mode) {
        if (this._state === 'idle') return true;
        const controller = this._driver.controller;
        if (!controller) return false;
        try {
            if (mode === 'inclusion') await controller.stopInclusion();
            else await controller.stopExclusion();
        } catch (err) {
            this.emit('warning', {
                severity: 'warn',
                code: mode === 'inclusion' ? 'INCLUSION_STOP_FAILED' : 'EXCLUSION_STOP_FAILED',
                message: err?.message || String(err),
                context: { mode },
            });
        }
        // Controller will emit '…-stopped' — we finalize state there. Also call it
        // directly in case the controller event never arrives (paranoia).
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
        logger.info(`Inclusion FSM: ${prev} → ${newState}${mode ? ` (${mode})` : ''}`);
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
        logger.info(`Inclusion FSM: ${prev} → idle`);
        this.emit('state-changed', 'idle', prev);
    }

    _onTimeout() {
        const mode = this._mode;
        logger.warn(`Inclusion FSM: ${mode} timeout reached — stopping`);
        this.emit('timeout', { mode });
        this.emit('warning', {
            severity: 'warn',
            code: mode === 'inclusion' ? 'INCLUSION_TIMEOUT' : 'EXCLUSION_TIMEOUT',
            message: `${mode} timed out after ${this._timeoutMs}ms`,
            context: { mode, timeout_ms: this._timeoutMs },
        });
        // Fire-and-forget stop — don't await (would hold the timer context).
        this._stop(mode).catch(() => { /* already reported */ });
    }

    _onModeStarted(mode) {
        // Controller confirmed start; if we didn't initiate (e.g. started via some
        // other path), synthesize the state so status is accurate.
        if (this._state === 'idle') {
            this._setState(mode === 'inclusion' ? 'including' : 'excluding', mode, this._defaultTimeoutMs);
        }
    }

    _onModeStopped(_mode) {
        this._finalize();
    }

    _onModeFailed(mode) {
        this.emit('warning', {
            severity: 'warn',
            code: mode === 'inclusion' ? 'INCLUSION_FAILED' : 'EXCLUSION_FAILED',
            message: `${mode} failed`,
            context: { mode },
        });
        this._finalize();
    }
}

module.exports = { ZWaveInclusion };
