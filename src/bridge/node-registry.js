'use strict';

/**
 * NodeRegistry — in-memory state for all configured nodes.
 *
 * Populated from config.nodes at startup; runtime state is mutated as
 * driver events arrive.  Methods return `changed` booleans so callers can
 * decide whether to publish a new retained MQTT message.
 */
class NodeRegistry {
    /**
     * @param {object} configNodes  - config.nodes map from ini-loader  { [label]: nodeConfig }
     */
    constructor(configNodes) {
        this._nodes = {};

        for (const [label, cfg] of Object.entries(configNodes)) {
            this._nodes[label] = {
                label,
                radio:         cfg.radio,
                type:          cfg.type,
                node_id:       cfg.node_id || null,
                ieee:          cfg.ieee    || null,
                base_topic:    cfg.base_topic,
                input_channel: cfg.input_channel || '0',
                description:   cfg.description  || '',
                // Runtime
                status:     'offline',
                last_event: null,
                signals:    {},
            };
        }
    }

    /** Return entry by label, or null. */
    getByLabel(label) {
        return this._nodes[label] || null;
    }

    /** Return first Z-Wave entry with the given integer node_id, or null. */
    getByZWaveId(nodeId) {
        const id = Number(nodeId);
        for (const entry of Object.values(this._nodes)) {
            if (entry.radio === 'zwave' && entry.node_id === id) return entry;
        }
        return null;
    }

    /** Return all entries as an array. */
    getAll() {
        return Object.values(this._nodes);
    }

    /**
     * Set operational status.  Returns true if the value changed.
     * @param {string} label
     * @param {'ready'|'interviewing'|'failed'|'offline'} status
     */
    setStatus(label, status) {
        const entry = this._nodes[label];
        if (!entry) return false;
        const changed = entry.status !== status;
        entry.status = status;
        return changed;
    }

    /**
     * Update a signal value.
     * @param {string} label
     * @param {'contact'|'relay'|'battery'|'reachable'} signalType
     * @param {*}      value
     * @returns {{ changed: boolean, entry: object|null }}
     */
    updateSignal(label, signalType, value) {
        const entry = this._nodes[label];
        if (!entry) return { changed: false, entry: null };

        const prev = entry.signals[signalType];
        const changed = !prev || prev.value !== value;
        if (changed) {
            entry.signals[signalType] = { value, ts: new Date().toISOString() };
        }
        return { changed, entry };
    }

    /**
     * Record the last event payload (after it has been normalized).
     * @param {string} label
     * @param {object} event - normalized event object
     */
    setLastEvent(label, event) {
        const entry = this._nodes[label];
        if (entry) entry.last_event = event;
    }

    /**
     * Returns a count summary for the heartbeat status payload.
     * @returns {{ total: number, ready: number, failed: number, interviewing: number }}
     */
    getSummary() {
        const counts = { total: 0, ready: 0, failed: 0, interviewing: 0 };
        for (const e of Object.values(this._nodes)) {
            counts.total++;
            if (e.status === 'ready')         counts.ready++;
            else if (e.status === 'failed')   counts.failed++;
            else if (e.status === 'interviewing') counts.interviewing++;
        }
        return counts;
    }
}

module.exports = { NodeRegistry };
