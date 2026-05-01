/**
 * src/lights/lifx.js — LIFX light adapter for PxB (R3-LIFX — Agent A3)
 *
 * Skeleton implementation showing the adapter pattern.
 * Manages LIFX smart light control via LAN protocol.
 *
 * This file is a template for agent A3 to implement.
 * See HueAdapter (src/lights/hue.js) for a complete reference implementation.
 */

'use strict';

const AdapterBase = require('../adapter-base');

class LifxAdapter extends AdapterBase {
    constructor({ config, mqttClient, logger }) {
        super({
            name: 'LifxAdapter',
            config,
            mqttClient,
            logger,
        });

        // Agent A3: Implement LIFX-specific initialization
        // Config keys: topic, api_key or discovery method, timeout_s, brightness
        this.logger.warn('LifxAdapter: Not yet implemented (R3-LIFX agent A3)');
    }

    async init() {
        this._assertNotDisposed();
        // Agent A3: TODO
        // 1. Discover LIFX devices on LAN or via API
        // 2. Subscribe to {topic}/commands
        // 3. Publish initial state
        // 4. Start polling for state updates
        throw new Error('LifxAdapter.init() not yet implemented');
    }

    async executeCommand(payload) {
        this._assertNotDisposed();
        // Agent A3: TODO
        // Handle setLight, setScene, allOn, allOff, etc.
        // Use pattern from HueAdapter as reference
        throw new Error('LifxAdapter.executeCommand() not yet implemented');
    }

    handleStateUpdate(state) {
        // Agent A3: TODO (if needed for upstream state integration)
    }

    async dispose() {
        this._assertNotDisposed();
        // Agent A3: TODO
        // Stop polling, unsubscribe, cleanup
        this._markDisposed();
    }
}

module.exports = LifxAdapter;
