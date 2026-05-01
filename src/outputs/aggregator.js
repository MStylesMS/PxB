/**
 * src/outputs/aggregator.js — Output aggregator for PxB
 *
 * Routes output commands to hardware drivers. Acts as a multiplexer:
 * a single MQTT topic receives commands and forwards them to the
 * appropriate adapter (relay node via NodeRegistry, GPIO via Pio, etc.).
 *
 * MQTT flow:
 *   {config.topic}/commands  →  OutputsAdapter  →  node command or relay driver
 *                                                   {config.topic}/state (retained)
 */

'use strict';

const AdapterBase = require('../adapter-base');

/**
 * OutputsAdapter — Routes output commands to hardware drivers.
 *
 * Config keys expected:
 *   - topic: MQTT topic for this zone
 */
class OutputsAdapter extends AdapterBase {
    constructor({ config, mqttClient, logger }) {
        super({ name: 'OutputsAdapter', config, mqttClient, logger });

        this._outputs = new Map();   // outputId → { type, state, ... }
        this._handlers = new Map();  // outputId → handler fn(payload) → Promise
        this._subscribed = false;
    }

    /**
     * Register hardware output handlers and subscribe to the commands topic.
     *
     * @param {Array<{id: string, type: string, handler: Function}>} outputs
     *   Each entry: { id, type ('relay'|'gpio'|...), handler: async (payload) => void }
     */
    async init(outputs = []) {
        this._assertNotDisposed();
        this.logger.info(`OutputsAdapter: Initializing (${outputs.length} outputs)`);

        for (const output of outputs) {
            this._outputs.set(output.id, { type: output.type, state: 'off', timestamp: null });
            this._handlers.set(output.id, output.handler);
        }

        const commandTopic = `${this.config.topic}/commands`;
        this.mqttClient.subscribe(commandTopic, (msg) => {
            this._handleCommand(msg).catch((err) => {
                this.logger.error(`OutputsAdapter: Command handler error: ${err.message}`);
            });
        });
        this._subscribed = true;

        this._publishState();
        this.logger.info('OutputsAdapter: Initialized');
    }

    async executeCommand(payload) {
        this._assertNotDisposed();
        if (!payload || typeof payload !== 'object') {
            this.publishWarning('OUTPUTS_CMD_INVALID', 'Command payload must be a JSON object');
            return;
        }

        const action = payload.action || payload.command;
        const { outputId } = payload;

        switch (action) {
            case 'setOutput': {
                if (!outputId) { this.publishWarning('OUTPUTS_MISSING_ID', 'outputId is required'); return; }
                await this._routeCommand(outputId, payload);
                break;
            }
            case 'pulse': {
                if (!outputId) { this.publishWarning('OUTPUTS_MISSING_ID', 'outputId is required'); return; }
                await this._pulse(outputId, payload.duration_ms || 500);
                break;
            }
            default:
                this.publishWarning('OUTPUTS_CMD_UNKNOWN', `Unknown action: ${action}`);
        }
    }

    /**
     * Called when an output's state changes (e.g., relay feedback from Z-Wave node).
     *
     * @param {string} outputId
     * @param {object} stateChange - { state, ... }
     */
    handleStateUpdate(outputId, stateChange) {
        const entry = this._outputs.get(outputId);
        if (!entry) return;
        entry.state = stateChange.state || entry.state;
        entry.timestamp = new Date().toISOString();
        this._publishState();
    }

    async dispose() {
        this._assertNotDisposed();

        if (this._subscribed) {
            this.mqttClient.unsubscribe(`${this.config.topic}/commands`).catch((err) => {
                this.logger.warn(`OutputsAdapter: Unsubscribe error: ${err.message}`);
            });
            this._subscribed = false;
        }

        this._markDisposed();
        this.logger.info('OutputsAdapter: Disposed');
    }

    // ---- Private Methods ----

    async _routeCommand(outputId, payload) {
        const handler = this._handlers.get(outputId);
        if (!handler) {
            this.publishWarning('OUTPUTS_UNKNOWN_ID', `No handler for outputId: ${outputId}`);
            return;
        }

        try {
            await handler(payload);
            const entry = this._outputs.get(outputId);
            if (entry) {
                entry.state = payload.on ? 'on' : 'off';
                entry.timestamp = new Date().toISOString();
            }
            this.publishEvent('output-set', { outputId, on: payload.on });
            this._publishState();
        } catch (err) {
            this.publishWarning('OUTPUTS_COMMAND_FAILED', `Command failed for ${outputId}: ${err.message}`);
        }
    }

    async _pulse(outputId, durationMs) {
        await this._routeCommand(outputId, { on: true });
        await new Promise((r) => setTimeout(r, durationMs));
        await this._routeCommand(outputId, { on: false });
        this.publishEvent('output-pulsed', { outputId, duration_ms: durationMs });
    }

    async _handleCommand(msg) {
        try { await this.executeCommand(JSON.parse(msg)); }
        catch (err) { this.logger.error(`OutputsAdapter: Failed to parse command: ${err.message}`); }
    }

    _publishState() {
        const outputs = {};
        for (const [id, entry] of this._outputs) {
            outputs[id] = { type: entry.type, state: entry.state, timestamp: entry.timestamp };
        }
        this.publishState({
            type: 'outputs',
            timestamp: new Date().toISOString(),
            outputs,
        });
    }
}

module.exports = OutputsAdapter;
