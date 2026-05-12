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
 * Status enum: 'ok' | 'crashed' | 'fatal'
 */

const { currentSubsystemId } = require('./async-context');
const logger = require('../util/logger');

const VALID_KINDS = new Set(['radio', 'output-adapter', 'dmx-bus', 'mqtt', 'http-api']);
const VALID_CRITICALITIES = new Set(['fatal', 'optional']);

class SubsystemRegistry {
    /**
     * @param {object} [opts]
     * @param {function} [opts.publishWarning] - (warningObj) => void  Called on crash to emit
     *   a MQTT warning. Optional; if absent, crashes are only logged.
     */
    constructor({ publishWarning } = {}) {
        this._subsystems = new Map(); // id → { id, kind, criticality, onCrash, status }
        this._publishWarning = typeof publishWarning === 'function' ? publishWarning : null;
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
            logger.debug(`SubsystemRegistry: re-registering subsystem "${id}"`);
        }

        this._subsystems.set(id, { id, kind, criticality, onCrash, status: 'ok' });
        logger.debug(`SubsystemRegistry: registered "${id}" (kind=${kind}, criticality=${criticality})`);
    }

    /**
     * Remove a subsystem from the registry.
     * No-op if the id is not registered.
     */
    unregister(id) {
        if (this._subsystems.has(id)) {
            this._subsystems.delete(id);
            logger.debug(`SubsystemRegistry: unregistered "${id}"`);
        }
    }

    /**
     * Best-effort attribution of the current error to a registered subsystem.
     *
     * Uses AsyncLocalStorage context (set by runInSubsystem) to identify the subsystem.
     * Falls back to null when no context is available or the id is not registered.
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
     * Contain a crash: mark the subsystem failed, publish a warning, and invoke onCrash.
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

        entry.status = 'crashed';

        const errMsg = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error ? (err.stack || err.message) : String(err);
        logger.error(`SubsystemRegistry: subsystem "${subsystemId}" (${entry.kind}) crashed — ${errStack}`);

        if (this._publishWarning) {
            try {
                this._publishWarning({
                    severity: 'error',
                    code: 'SUBSYSTEM_CRASH',
                    message: `Subsystem "${subsystemId}" (${entry.kind}) crashed: ${errMsg}`,
                    context: { subsystem_id: subsystemId, kind: entry.kind },
                });
            } catch (publishErr) {
                logger.warn(`SubsystemRegistry: failed to publish crash warning: ${publishErr.message}`);
            }
        }

        try {
            await entry.onCrash(err);
        } catch (handlerErr) {
            logger.error(`SubsystemRegistry: onCrash for "${subsystemId}" threw: ${handlerErr.message}`);
        }
    }

    /**
     * Return a summary of all registered subsystem statuses.
     *
     * @returns {object} e.g. { 'zwave-driver': 'ok', 'hue-mirror': 'crashed' }
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
