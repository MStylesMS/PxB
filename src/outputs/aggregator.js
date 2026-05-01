/**
 * src/outputs/aggregator.js — Output aggregator for PxB (R4-RelaysInputs — Agent A6)
 *
 * Skeleton implementation for the outputs domain.
 * Routes output commands to hardware (relays, GPIO, etc.).
 *
 * This file is a template for agent A6 to implement.
 * See HueAdapter (src/lights/hue.js) for a complete reference implementation.
 */

'use strict';

const AdapterBase = require('../adapter-base');

class OutputsAdapter extends AdapterBase {
    constructor({ config, mqttClient, logger }) {
        super({
            name: 'OutputsAdapter',
            config,
            mqttClient,
            logger,
        });

        // Config keys: topic
        this.logger.warn('OutputsAdapter: Not yet implemented (R4-RelaysInputs agent A6)');
    }

    async init() {
        this._assertNotDisposed();
        // Agent A6: TODO
        // 1. Subscribe to {topic}/commands
        // 2. Register output handlers (relay, GPIO, etc.)
        // 3. Publish initial output state
        throw new Error('OutputsAdapter.init() not yet implemented');
    }

    async executeCommand(payload) {
        this._assertNotDisposed();
        // Agent A6: TODO
        // Handle setOutput, pulse, etc.
        // Route to underlying hardware drivers
        throw new Error('OutputsAdapter.executeCommand() not yet implemented');
    }

    handleStateUpdate(state) {
        // Agent A6: TODO (if needed)
    }

    async dispose() {
        this._assertNotDisposed();
        // Agent A6: TODO
        // Unsubscribe, cleanup
        this._markDisposed();
    }
}

module.exports = OutputsAdapter;
