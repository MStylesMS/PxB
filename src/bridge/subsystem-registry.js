'use strict';

/**
 * SubsystemRegistry — Tracks live subsystems and contains per-subsystem crashes.
 *
 * Each long-lived component in PxB registers itself here. When the global
 * uncaughtException / unhandledRejection handlers fire, they ask the registry to
 * attribute the error to a subsystem. If the subsystem is 'optional', the registry
 * invokes its onCrash handler and the process keeps running. If the subsystem is
 * 'fatal' (or unattributed), the existing shutdown path runs instead.
 *
 * Attribution is best-effort via AsyncLocalStorage. If the async context is lost
 * (e.g. a native add-on callback), attribution returns null and the fallback
 * shutdown path preserves today's safe behavior.
 *
 * Kind enum: 'radio' | 'output-adapter' | 'dmx-bus' | 'mqtt' | 'http-api'
 * Criticality enum: 'fatal' | 'optional'
 * Status enum: 'ok' | 'crashed' | 'cooling-down' | 'quarantined' | 'fatal'
 *
 * Crash budget policy (defaults, tunable via constructor options):
 *   ≤ CRASH_LIMIT_WARN crashes in CRASH_WINDOW_MS   → contain and continue ('ok')
 *   CRASH_LIMIT_WARN+1 – CRASH_LIMIT_COOL crashes   → 'cooling-down' for COOLDOWN_MS
 *   > CRASH_LIMIT_COOL crashes AND second cooldown   → 'quarantined' permanently
 */

const { currentSubsystemId } = require('./async-context');
const logger = require('../util/logger');

const VALID_KINDS = new Set(['radio', 'output-adapter', 'dmx-bus', 'mqtt', 'http-api']);
const VALID_CRITICALITIES = new Set(['fatal', 'optional']);

const DEFAULT_CRASH_WINDOW_MS = 60_000;  // sliding window for crash counting
const DEFAULT_CRASH_LIMIT_WARN = 3;      // ≤ this → contained, stay 'ok'
const DEFAULT_CRASH_LIMIT_COOL = 10;     // ≤ this → 'cooling-down'
const DEFAULT_COOLDOWN_MS = 60_000;      // duration of cooling-down suppression

class SubsystemRegistry {
    /**
     * @param {object} [opts]
     * @param {function} [opts.publishWarning]   - (warningObj) => void
     * @param {number}   [opts.crashWindowMs]    - sliding window in ms (default 60 000)
     * @param {number}   [opts.crashLimitWarn]   - ≤ this many crashes → stay ok (default 3)
     * @param {number}   [opts.crashLimitCool]   - > this → quarantine instead of cooldown (default 10)
     * @param {number}   [opts.cooldownMs]       - cooldown suppression duration (default 60 000)
     */
    constructor({
        publishWarning,
        crashWindowMs = DEFAULT_CRASH_WINDOW_MS,
        crashLimitWarn = DEFAULT_CRASH_LIMIT_WARN,
        crashLimitCool = DEFAULT_CRASH_LIMIT_COOL,
        cooldownMs = DEFAULT_COOLDOWN_MS,
    } = {}) {
        this._subsystems = new Map(); // id → entry
        this._publishWarning = typeof publishWarning === 'function' ? publishWarning : null;
        this._crashWindowMs = crashWindowMs;
        this._crashLimitWarn = crashLimitWarn;
        this._crashLimitCool = crashLimitCool;
        this._cooldownMs = cooldownMs;
    }

    /**
     * Register (or re-register) a subsystem.
     *
     * Re-registration is allowed; it replaces the existing entry in place.
     * This is intentional for radio drivers that reconnect and re-register themselves.
     *
     * @param {object} opts
     * @param {string}   opts.id          - Unique subsystem id (e.g. 'zwave-driver')
     * @param {string}   opts.kind        - One of VALID_KINDS
     * @param {string}   opts.criticality - 'fatal' | 'optional'
     * @param {function} opts.onCrash     - async (err: Error|*) => void
     */
    register({ id, kind, criticality, onCrash }) {
        if (!id || typeof id !== 'string') {
            throw new Error('SubsystemRegistry.register: id must be a non-empty string');
        }
        if (!VALID_KINDS.has(kind)) {
            throw new Error(`SubsystemRegistry.register: unknown kind "${kind}" — must be one of: ${[...VALID_KINDS].join(', ')}`);
        }
        if (!VALID_CRITICALITIES.has(criticality)) {
            throw new Error(`SubsystemRegistry.register: unknown criticality "${criticality}" — must be 'fatal' or 'optional'`);
        }
        if (typeof onCrash !== 'function') {
            throw new Error('SubsystemRegistry.register: onCrash must be a function');
        }

        const existing = this._subsystems.get(id);
        if (existing) {
            // Clear any pending cooldown timer on re-registration.
            if (existing._cooldownTimer) {
                clearTimeout(existing._cooldownTimer);
            }
            logger.debug(`SubsystemRegistry: re-registering subsystem "${id}"`);
        }

        this._subsystems.set(id, {
            id,
            kind,
            criticality,
            onCrash,
            status: 'ok',
            // crash-budget bookkeeping
            crashCount: 0,
            firstCrashAt: null,
            lastCrashAt: null,
            cooldownCycles: 0,
            _cooldownTimer: null,
        });
        logger.debug(`SubsystemRegistry: registered "${id}" (kind=${kind}, criticality=${criticality})`);
    }

    /**
     * Remove a subsystem from the registry.
     * No-op if the id is not registered.
     */
    unregister(id) {
        const entry = this._subsystems.get(id);
        if (entry) {
            if (entry._cooldownTimer) clearTimeout(entry._cooldownTimer);
            this._subsystems.delete(id);
            logger.debug(`SubsystemRegistry: unregistered "${id}"`);
        }
    }

    /**
     * Best-effort attribution of the current error to a registered subsystem.
     *
     * @returns {{ subsystemId: string, criticality: string } | null}
     */
    attribute() {
        const id = currentSubsystemId();
        if (!id) return null;
        const entry = this._subsystems.get(id);
        if (!entry) return null;
        return { subsystemId: id, criticality: entry.criticality };
    }

    /**
     * Contain a crash: apply the crash budget, update status, publish a warning,
     * and invoke onCrash — unless the subsystem is cooling-down or quarantined.
     *
     * @param {string} subsystemId
     * @param {Error|*} err
     * @returns {Promise<void>}
     */
    async crash(subsystemId, err) {
        const entry = this._subsystems.get(subsystemId);
        if (!entry) {
            logger.warn(`SubsystemRegistry.crash: unknown subsystem "${subsystemId}" — skipping containment`);
            return;
        }

        // --- Quarantined subsystems are permanently silenced ---
        if (entry.status === 'quarantined') {
            logger.debug(`SubsystemRegistry: crash for quarantined subsystem "${subsystemId}" — suppressed`);
            return;
        }

        // --- Cooling-down subsystems are suppressed until the timer fires ---
        if (entry.status === 'cooling-down') {
            logger.debug(`SubsystemRegistry: crash for cooling-down subsystem "${subsystemId}" — suppressed`);
            return;
        }

        // --- Update crash budget ---
        const now = Date.now();

        // Reset the window if enough time has passed since the first crash in it.
        if (entry.firstCrashAt !== null && (now - entry.firstCrashAt) > this._crashWindowMs) {
            entry.crashCount = 0;
            entry.firstCrashAt = null;
        }

        if (entry.firstCrashAt === null) {
            entry.firstCrashAt = now;
        }
        entry.crashCount++;
        entry.lastCrashAt = now;

        const errMsg = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error ? (err.stack || err.message) : String(err);

        // --- Publish SUBSYSTEM_CRASH warning ---
        logger.error(`SubsystemRegistry: subsystem "${subsystemId}" (${entry.kind}) crashed — ${errStack}`);
        this._emitCrashWarning(subsystemId, entry, errMsg);

        // --- Apply budget policy ---
        if (entry.crashCount > this._crashLimitCool) {
            // Extreme burst in a single window → skip cooldown, quarantine immediately
            await this._quarantine(entry, err);
            return;
        }

        if (entry.crashCount > this._crashLimitWarn) {
            if (entry.cooldownCycles >= 1) {
                // Already been through one cooldown and still crashing → quarantine
                await this._quarantine(entry, err);
                return;
            }
            // First time exceeding the warn limit → enter cooling-down
            await this._enterCooldown(entry, err);
            return;
        }

        // --- Within budget: contain normally ---
        entry.status = 'crashed';
        await this._invokeOnCrash(entry, err);
    }

    // ---- Private helpers ----

    async _invokeOnCrash(entry, err) {
        try {
            await entry.onCrash(err);
        } catch (handlerErr) {
            logger.error(`SubsystemRegistry: onCrash for "${entry.id}" threw: ${handlerErr.message}`);
        }
    }

    async _enterCooldown(entry, err) {
        entry.status = 'cooling-down';
        logger.warn(`SubsystemRegistry: subsystem "${entry.id}" entering cooling-down (${entry.crashCount} crashes in ${this._crashWindowMs / 1000}s window)`);

        // Invoke onCrash once to stop the subsystem during cooldown.
        await this._invokeOnCrash(entry, err);

        // After cooldown expires, reset the window so new crashes are counted fresh.
        entry._cooldownTimer = setTimeout(() => {
            if (entry.status === 'cooling-down') {
                entry.status = 'crashed';
                entry.crashCount = 0;
                entry.firstCrashAt = null;
                entry.cooldownCycles++;
                logger.info(`SubsystemRegistry: subsystem "${entry.id}" cooldown expired — monitoring resumed`);
            }
            entry._cooldownTimer = null;
        }, this._cooldownMs);
        // Don't hold the process open for this timer.
        if (entry._cooldownTimer.unref) entry._cooldownTimer.unref();
    }

    async _quarantine(entry, err) {
        entry.status = 'quarantined';
        logger.error(`SubsystemRegistry: subsystem "${entry.id}" QUARANTINED after ${entry.crashCount} crashes — permanently disabled until restart`);

        this._emitQuarantineWarning(entry);

        // Invoke onCrash one final time to ensure cleanup.
        await this._invokeOnCrash(entry, err);
    }

    _emitCrashWarning(subsystemId, entry, errMsg) {
        if (!this._publishWarning) return;
        try {
            this._publishWarning({
                severity: 'error',
                code: 'SUBSYSTEM_CRASH',
                message: `Subsystem "${subsystemId}" (${entry.kind}) crashed: ${errMsg}`,
                context: {
                    subsystem_id: subsystemId,
                    kind: entry.kind,
                    crash_count: entry.crashCount,
                },
            });
        } catch (publishErr) {
            logger.warn(`SubsystemRegistry: failed to publish crash warning: ${publishErr.message}`);
        }
    }

    _emitQuarantineWarning(entry) {
        if (!this._publishWarning) return;
        try {
            this._publishWarning({
                severity: 'error',
                code: 'SUBSYSTEM_QUARANTINED',
                message: `Subsystem "${entry.id}" has been quarantined after ${entry.crashCount} crashes — permanently disabled until restart`,
                context: {
                    subsystem_id: entry.id,
                    kind: entry.kind,
                    crash_count: entry.crashCount,
                    window_s: this._crashWindowMs / 1000,
                },
            });
        } catch (publishErr) {
            logger.warn(`SubsystemRegistry: failed to publish quarantine warning: ${publishErr.message}`);
        }
    }

    /**
     * Return a summary of all registered subsystem statuses.
     *
     * @returns {object} e.g. { 'zwave-driver': 'ok', 'light-mirror': 'cooling-down' }
     */
    getSummary() {
        const summary = {};
        for (const [id, entry] of this._subsystems) {
            summary[id] = entry.status;
        }
        return summary;
    }
}

module.exports = { SubsystemRegistry };
