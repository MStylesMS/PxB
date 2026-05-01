/**
 * src/inputs/aggregator.js — Input aggregator for PxB (R4-RelaysInputs — Agent A6)
 *
 * Skeleton implementation for the inputs domain.
 * Aggregates sensor inputs (contact, motion, etc.) from radio nodes.
 *
 * This file is a template for agent A6 to implement.
 * See HueAdapter (src/lights/hue.js) for a complete reference implementation.
 */

'use strict';

const AdapterBase = require('../adapter-base');

class InputsAdapter extends AdapterBase {
    constructor({ config, mqttClient, nodeRegistry, logger }) {
        super({
            name: 'InputsAdapter',
            config,
            mqttClient,
            logger,
        });

        this.nodeRegistry = nodeRegistry;
        // Config keys: topic, filter_duplicates_ms (optional)
        this.logger.warn('InputsAdapter: Not yet implemented (R4-RelaysInputs agent A6)');
    }

    async init() {
        this._assertNotDisposed();
        // Agent A6: TODO
        // 1. Subscribe to node input events from nodeRegistry
        // 2. Subscribe to {topic}/commands (if needed for input zone config)
        // 3. Publish aggregated input state
        // 4. Apply duplicate filtering if configured
        throw new Error('InputsAdapter.init() not yet implemented');
    }

    async executeCommand(payload) {
        this._assertNotDisposed();
        // Agent A6: TODO
        // Inputs are typically read-only; handle config/query commands if needed
        throw new Error('InputsAdapter.executeCommand() not yet implemented');
    }

    handleStateUpdate(state) {
        // Agent A6: TODO
        // Called when a node's input state changes (contact opened/closed, motion detected, etc.)
        // Publish aggregated state to {topic}/state
    }

    async dispose() {
        this._assertNotDisposed();
        // Agent A6: TODO
        // Unsubscribe from node events, cleanup
        this._markDisposed();
    }
}

module.exports = InputsAdapter;
