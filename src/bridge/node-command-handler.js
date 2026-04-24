'use strict';

const logger = require('../util/logger');
const { nodeTopics } = require('../mqtt/contract');
const { setBinarySwitch, pulseBinarySwitch } = require('../radios/zwave/commands');
const { setOnOff, pulseOnOff } = require('../radios/zigbee/commands');

/**
 * NodeCommandHandler — subscribes to `{nodeBaseTopic}/commands` for every
 * configured node and dispatches device-control commands.
 *
 * Currently supported commands (relay/switch type nodes):
 *   { "command": "setRelay", "state": "on" | "off" }
 *   { "command": "pulseRelay", "ms": 500 }
 *
 * On success, updates `entry.signals.relay` and publishes retained state
 * through ZWaveEvents.
 *
 * On failure, publishes a non-retained warning to `{nodeBaseTopic}/warnings`.
 */
class NodeCommandHandler {
    /**
     * @param {object} opts
     * @param {import('../mqtt/client').MqttClient} opts.mqttClient
     * @param {import('./node-registry').NodeRegistry} opts.nodeRegistry
     * @param {import('../radios/zwave/driver').ZWaveDriver} [opts.zwaveDriver]
     * @param {import('../radios/zwave/events').ZWaveEvents} [opts.zwaveEvents]
     * @param {import('../radios/zigbee/driver').ZigbeeDriver} [opts.zigbeeDriver]
     * @param {import('../radios/zigbee/events').ZigbeeEvents} [opts.zigbeeEvents]
     */
    constructor({ mqttClient, nodeRegistry, zwaveDriver, zwaveEvents, zigbeeDriver, zigbeeEvents }) {
        this._mqtt = mqttClient;
        this._registry = nodeRegistry;
        this._zwaveDriver = zwaveDriver || null;
        this._zwaveEvents = zwaveEvents || null;
        this._zigbeeDriver = zigbeeDriver || null;
        this._zigbeeEvents = zigbeeEvents || null;

        for (const entry of this._registry.getAll()) {
            if (!entry.base_topic) continue;
            const topics = nodeTopics(entry.base_topic);
            this._mqtt.subscribe(topics.commands, (topic, payload) => {
                this._dispatch(entry, payload).catch((err) => {
                    logger.error(`NodeCommandHandler[${entry.label}] dispatch error: ${err.message}`);
                });
            });
            logger.debug(`NodeCommandHandler listening ${topics.commands} → ${entry.label}`);
        }
    }

    async _dispatch(entry, payload) {
        if (!payload || typeof payload !== 'object') {
            this._warn(entry, 'warn', 'BAD_COMMAND', 'Non-object payload ignored', {});
            return;
        }
        const { command } = payload;
        if (!command) {
            this._warn(entry, 'warn', 'BAD_COMMAND', 'Missing "command" field', { payload });
            return;
        }

        switch (command) {
            case 'setRelay':
                return this._handleSetRelay(entry, payload);
            case 'pulseRelay':
                return this._handlePulseRelay(entry, payload);
            default:
                this._warn(entry, 'warn', 'UNKNOWN_COMMAND', `Unknown command: ${command}`, { command });
        }
    }

    async _handleSetRelay(entry, payload) {
        if (!this._isRelayCapable(entry)) {
            this._warn(entry, 'warn', 'COMMAND_UNSUPPORTED',
                `setRelay not supported for type=${entry.type}`, { type: entry.type });
            return;
        }
        const stateStr = String(payload.state || '').toLowerCase();
        if (stateStr !== 'on' && stateStr !== 'off') {
            this._warn(entry, 'warn', 'BAD_COMMAND', 'state must be "on" or "off"', { payload });
            return;
        }
        const value = stateStr === 'on';
        try {
            if (entry.radio === 'zigbee') {
                await setOnOff(this._zigbeeDriver, entry.ieee, value);
            } else {
                await setBinarySwitch(this._zwaveDriver, entry.node_id, value);
            }
            this._echoRelay(entry, stateStr);
        } catch (err) {
            this._warn(entry, 'error', err.code || 'COMMAND_FAILED', err.message, {
                command: 'setRelay', state: stateStr,
            });
        }
    }

    async _handlePulseRelay(entry, payload) {
        if (!this._isRelayCapable(entry)) {
            this._warn(entry, 'warn', 'COMMAND_UNSUPPORTED',
                `pulseRelay not supported for type=${entry.type}`, { type: entry.type });
            return;
        }
        const ms = Number(payload.ms) || 500;
        try {
            if (entry.radio === 'zigbee') {
                await pulseOnOff(this._zigbeeDriver, entry.ieee, ms);
            } else {
                await pulseBinarySwitch(this._zwaveDriver, entry.node_id, ms);
            }
            this._echoRelay(entry, 'off');
        } catch (err) {
            this._warn(entry, 'error', err.code || 'COMMAND_FAILED', err.message, {
                command: 'pulseRelay', ms,
            });
        }
    }

    _isRelayCapable(entry) {
        if (entry.type !== 'relay' && entry.type !== 'switch') return false;
        if (entry.radio === 'zwave') {
            return !!(this._zwaveDriver && this._zwaveDriver.connected);
        }
        if (entry.radio === 'zigbee') {
            return !!(this._zigbeeDriver && this._zigbeeDriver.connected);
        }
        return false;
    }

    _echoRelay(entry, value) {
        const { changed } = this._registry.updateSignal(entry.label, 'relay', value);
        const normalized = { type: 'relay', value };
        const source = entry.radio === 'zigbee'
            ? `zigbee-${entry.ieee}`
            : `zwave-node-${entry.node_id}`;
        this._registry.setLastEvent(entry.label, {
            event: normalized,
            ts: new Date().toISOString(),
            source,
        });
        // Prefer radio-specific publisher so state payload carries the right schema.
        const pub = entry.radio === 'zigbee' ? this._zigbeeEvents : this._zwaveEvents;
        if (pub && typeof pub.publishNodeState === 'function') {
            pub.publishNodeState(entry);
        }
        logger.info(`Relay ${entry.label} → ${value}${changed ? '' : ' (unchanged)'}`);
    }

    _warn(entry, severity, code, message, context) {
        const topic = nodeTopics(entry.base_topic).warnings;
        this._mqtt.publish(topic, {
            timestamp: new Date().toISOString(),
            severity,
            code,
            message,
            context: { label: entry.label, ...context },
        }, { retain: false });
        logger[severity === 'error' ? 'error' : 'warn'](
            `NodeWarning[${entry.label}] ${code}: ${message}`
        );
    }
}

module.exports = { NodeCommandHandler };
