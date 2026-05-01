/**
 * src/inputs/aggregator.js — Input aggregator for PxB
 *
 * Subscribes to individual node event topics (contact, motion, etc.) and
 * aggregates their state. Consumers (PxO, operator UIs) subscribe to this
 * zone's topic for a single authoritative view of all inputs.
 *
 * MQTT flow:
 *   {node.base_topic}/events  →  InputsAdapter  →  {config.topic}/state (retained)
 *                                                   {config.topic}/events (non-retained)
 */

'use strict';

const AdapterBase = require('../adapter-base');

/**
 * InputsAdapter — Aggregates input state from radio nodes.
 *
 * Config keys expected:
 *   - topic: MQTT topic for this zone
 *   - filter_duplicates_ms: Suppress repeated identical events within this window (optional, default 100)
 */
class InputsAdapter extends AdapterBase {
    constructor({ config, mqttClient, logger }) {
        super({ name: 'InputsAdapter', config, mqttClient, logger });

        this.filterMs = config.filter_duplicates_ms || 100;
        this._inputs = new Map();       // nodeLabel → { state, value, timestamp }
        this._lastEvents = new Map();   // "label:event" → timestamp (for duplicate filtering)
        this._subscriptions = [];       // Topics subscribed to node events
    }

    /**
     * Subscribe to node event topics from a provided list of node configs.
     * Call this after MQTT is connected and before processing events.
     *
     * @param {Array<{label: string, base_topic: string, type: string}>} nodes
     */
    async init(nodes = []) {
        this._assertNotDisposed();
        this.logger.info(`InputsAdapter: Initializing (${nodes.length} nodes)`);

        for (const node of nodes) {
            const eventTopic = `${node.base_topic}/events`;
            this.mqttClient.subscribe(eventTopic, (msg) => {
                this._handleNodeEvent(node.label, msg);
            });
            this._subscriptions.push(eventTopic);
            this._inputs.set(node.label, { type: node.type, state: 'unknown', value: null, timestamp: null });
        }

        this._publishState();
        this.logger.info('InputsAdapter: Initialized');
    }

    async executeCommand(payload) {
        this._assertNotDisposed();
        if (!payload || typeof payload !== 'object') {
            this.publishWarning('INPUTS_CMD_INVALID', 'Command payload must be a JSON object');
            return;
        }

        const action = payload.action || payload.command;
        if (action === 'getState') {
            this._publishState();
        } else {
            this.publishWarning('INPUTS_CMD_UNKNOWN', `Inputs zone is read-only; unknown action: ${action}`);
        }
    }

    /**
     * Called by external event handlers when a node's state changes.
     *
     * @param {string} nodeLabel
     * @param {object} stateChange - { state, value, ... }
     */
    handleStateUpdate(nodeLabel, stateChange) {
        const entry = this._inputs.get(nodeLabel);
        if (!entry) return;

        entry.state = stateChange.state || entry.state;
        entry.value = stateChange.value !== undefined ? stateChange.value : entry.value;
        entry.timestamp = new Date().toISOString();

        this._publishState();
    }

    async dispose() {
        this._assertNotDisposed();

        for (const topic of this._subscriptions) {
            this.mqttClient.unsubscribe(topic).catch((err) => {
                this.logger.warn(`InputsAdapter: Unsubscribe error (${topic}): ${err.message}`);
            });
        }
        this._subscriptions = [];

        this._markDisposed();
        this.logger.info('InputsAdapter: Disposed');
    }

    // ---- Private Methods ----

    /**
     * Handle raw MQTT event from a node topic.
     */
    _handleNodeEvent(nodeLabel, msg) {
        let event;
        try { event = JSON.parse(msg); } catch { return; }
        if (!event || typeof event !== 'object') return;

        // Duplicate suppression: skip events with same value within filter window
        const key = `${nodeLabel}:${event.event || ''}:${JSON.stringify(event.value)}`;
        const now = Date.now();
        const last = this._lastEvents.get(key);
        if (last && (now - last) < this.filterMs) return;
        this._lastEvents.set(key, now);

        this.handleStateUpdate(nodeLabel, {
            state: event.state || event.event,
            value: event.value,
        });

        // Forward event to zone events topic
        this.publishEvent('input-changed', {
            node: nodeLabel,
            state: event.state || event.event,
            value: event.value,
        });
    }

    _publishState() {
        const inputs = {};
        for (const [label, entry] of this._inputs) {
            inputs[label] = { type: entry.type, state: entry.state, value: entry.value, timestamp: entry.timestamp };
        }
        this.publishState({
            type: 'inputs',
            timestamp: new Date().toISOString(),
            inputs,
        });
    }
}

module.exports = InputsAdapter;
