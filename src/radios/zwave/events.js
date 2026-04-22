'use strict';

const logger = require('../../util/logger');
const { normalizeContact } = require('../../bridge/normalizer');
const { nodeTopics } = require('../../mqtt/contract');

/**
 * ZWaveEvents — bridges ZWaveDriver node-level events into MQTT publishes.
 *
 * Listens to 'node-value-updated' and 'node-status-changed' from ZWaveDriver,
 * normalizes them via the normalizer, updates the NodeRegistry, and publishes
 * retained events + state only when something actually changes.
 */
class ZWaveEvents {
    /**
     * @param {object} opts
     * @param {import('../zwave/driver').ZWaveDriver} opts.zwaveDriver
     * @param {import('../../bridge/node-registry').NodeRegistry}  opts.nodeRegistry
     * @param {import('../../mqtt/client').MqttClient}             opts.mqttClient
     */
    constructor({ zwaveDriver, nodeRegistry, mqttClient }) {
        this._driver   = zwaveDriver;
        this._registry = nodeRegistry;
        this._mqtt     = mqttClient;

        this._driver.on('node-value-updated',   (ev) => this._onValueUpdated(ev));
        this._driver.on('node-status-changed',  (ev) => this._onStatusChanged(ev));
        this._driver.on('connected',            ()   => this._onDriverConnected());
        this._driver.on('disconnected',         ()   => this._onDriverDisconnected());
    }

    // --- Driver lifecycle ---

    _onDriverConnected() {
        // Mark all Z-Wave configured nodes as 'interviewing' until we get a status update.
        for (const entry of this._registry.getAll()) {
            if (entry.radio === 'zwave') {
                this._registry.setStatus(entry.label, 'interviewing');
            }
        }
    }

    _onDriverDisconnected() {
        for (const entry of this._registry.getAll()) {
            if (entry.radio === 'zwave') {
                const changed = this._registry.setStatus(entry.label, 'offline');
                if (changed) this._publishState(entry.label);
            }
        }
    }

    // --- Per-node events ---

    _onStatusChanged({ nodeId, status }) {
        const entry = this._registry.getByZWaveId(nodeId);
        if (!entry) {
            logger.debug(`Z-Wave status update for unconfigured node ${nodeId} (${status}) — ignored`);
            return;
        }
        const changed = this._registry.setStatus(entry.label, status);
        if (changed) {
            logger.info(`Node "${entry.label}" (zwave-node-${nodeId}) status → ${status}`);
            this._publishState(entry.label);
        }
    }

    _onValueUpdated({ nodeId, commandClass, property, propertyKey, newValue, oldValue }) {
        const entry = this._registry.getByZWaveId(nodeId);
        if (!entry) {
            logger.debug(
                `Z-Wave value update for unconfigured node ${nodeId} CC ${commandClass} — ignored`
            );
            return;
        }

        // Only process contact/sensor types in phase 1
        if (entry.type !== 'contact') {
            logger.debug(`Node "${entry.label}" type=${entry.type} — value update not handled in phase 1`);
            return;
        }

        const normalized = normalizeContact(commandClass, property, newValue);
        if (normalized === null) {
            logger.debug(
                `Node "${entry.label}" CC ${commandClass} property="${property}" value=${JSON.stringify(newValue)} — not normalizable`
            );
            return;
        }

        const source = `zwave-node-${nodeId}`;
        const ts = Date.now();

        const eventPayload = {
            input:  entry.input_channel,
            event:  normalized,
            source,
            ts,
            raw: {
                commandClass,
                property,
                propertyKey: propertyKey ?? null,
                newValue,
                oldValue: oldValue ?? null,
            },
        };

        // Update signal (returns whether value changed)
        const { changed } = this._registry.updateSignal(entry.label, 'contact', normalized);
        this._registry.setLastEvent(entry.label, eventPayload);

        if (changed) {
            logger.info(`Node "${entry.label}" contact → ${normalized} (CC ${commandClass}/${property}=${newValue})`);
            this._publishEvent(entry.label, eventPayload);
            this._publishState(entry.label);
        } else {
            logger.debug(`Node "${entry.label}" contact ${normalized} (no change — not republished)`);
        }
    }

    // --- MQTT publish helpers ---

    _publishEvent(label, payload) {
        const entry = this._registry.getByLabel(label);
        if (!entry) return;
        const topics = nodeTopics(entry.base_topic);
        this._mqtt.publish(topics.events, payload, { retain: true });
    }

    _publishState(label) {
        const entry = this._registry.getByLabel(label);
        if (!entry) return;
        const topics = nodeTopics(entry.base_topic);
        const state = {
            timestamp:  new Date().toISOString(),
            label:      entry.label,
            radio:      entry.radio,
            type:       entry.type,
            status:     entry.status,
            last_event: entry.last_event,
            signals:    entry.signals,
        };
        this._mqtt.publish(topics.state, state, { retain: true });
    }
}

module.exports = { ZWaveEvents };
