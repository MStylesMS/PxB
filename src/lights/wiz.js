/**
 * src/lights/wiz.js — WiZ light adapter for PxB (R3-WiZ — Agent A4)
 *
 * Skeleton implementation showing the adapter pattern.
 * Manages WiZ smart light control via UDP protocol.
 *
 * This file is a template for agent A4 to implement.
 * See HueAdapter (src/lights/hue.js) for a complete reference implementation.
 */

'use strict';

const AdapterBase = require('../adapter-base');

class WizAdapter extends AdapterBase {
    constructor({ config, mqttClient, logger }) {
        super({
            name: 'WizAdapter',
            config,
            mqttClient,
            logger,
        });

        // Agent A4: Implement WiZ-specific initialization
        // Config keys: topic, host (or discovery), port, timeout_s, brightness
        this.logger.warn('WizAdapter: Not yet implemented (R3-WiZ agent A4)');
    }

    async init() {
        this._assertNotDisposed();
        // Agent A4: TODO
        // 1. Discover WiZ devices on LAN (UDP broadcast)
        // 2. Subscribe to {topic}/commands
        // 3. Publish initial state
        // 4. Start polling for state updates via UDP
        throw new Error('WizAdapter.init() not yet implemented');
    }

    async executeCommand(payload) {
        this._assertNotDisposed();
        // Agent A4: TODO
        // Handle setLight, setScene, allOn, allOff, etc.
        // Use pattern from HueAdapter as reference, but with UDP instead of HTTP
        throw new Error('WizAdapter.executeCommand() not yet implemented');
    }

    handleStateUpdate(state) {
        // Agent A4: TODO (if needed for upstream state integration)
    }

    async dispose() {
        this._assertNotDisposed();
        // Agent A4: TODO
        // Stop polling, unsubscribe, cleanup
        this._markDisposed();
    }
}

module.exports = WizAdapter;
