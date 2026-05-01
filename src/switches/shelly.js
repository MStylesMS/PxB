/**
 * src/switches/shelly.js — Shelly smart switch adapter for PxB (R4-Shelly — Agent A5)
 *
 * Skeleton implementation showing the adapter pattern.
 * Manages Shelly smart switches and relays via REST API.
 *
 * This file is a template for agent A5 to implement (high-judgment local work).
 * See HueAdapter (src/lights/hue.js) for a complete reference implementation.
 */

'use strict';

const AdapterBase = require('../adapter-base');

class ShellyAdapter extends AdapterBase {
    constructor({ config, mqttClient, logger }) {
        super({
            name: 'ShellyAdapter',
            config,
            mqttClient,
            logger,
        });

        // Agent A5: Implement Shelly-specific initialization
        // Config keys: topic, host, port (optional), timeout_s, ...
        // Shelly has model-specific behavior (1, 1PM, 2.5, i3, Plus variants, etc.)
        this.logger.warn('ShellyAdapter: Not yet implemented (R4-Shelly agent A5)');
    }

    async init() {
        this._assertNotDisposed();
        // Agent A5: TODO
        // 1. Fetch device info from Shelly (model, channels, firmware)
        // 2. Subscribe to {topic}/commands
        // 3. Publish initial state (relay on/off, power, temperature, etc.)
        // 4. Start polling for state updates
        // Note: Shelly has CoAP and REST APIs; choose based on requirements
        throw new Error('ShellyAdapter.init() not yet implemented');
    }

    async executeCommand(payload) {
        this._assertNotDisposed();
        // Agent A5: TODO
        // Handle setRelay, pulse, etc.
        // Model-specific: some Shelly variants have different command structures
        throw new Error('ShellyAdapter.executeCommand() not yet implemented');
    }

    handleStateUpdate(state) {
        // Agent A5: TODO (if needed for upstream state integration)
    }

    async dispose() {
        this._assertNotDisposed();
        // Agent A5: TODO
        // Stop polling, unsubscribe, cleanup
        this._markDisposed();
    }
}

module.exports = ShellyAdapter;
