'use strict';

const logger = require('../../util/logger');
const { normalizeContact, normalizeBattery } = require('../../bridge/normalizer');
const { nodeTopics } = require('../../mqtt/contract');

/**
 * ZWaveEvents — bridges ZWaveDriver node-level events into MQTT publishes.
 *
 * Listens to 'node-value-updated' and 'node-status-changed' from ZWaveDriver,
 * normalizes them via the normalizer, updates the NodeRegistry, and publishes
 * retained events + state only when telemetry actually changes.
 *
 * Also publishes a retained per-node `schema` message once per node on
 * construction (and again when the driver reconnects) so consumers can
 * discover the topic layout and state/event shape.
 */
class ZWaveEvents {
    /**
     * @param {object} opts
     * @param {import('../zwave/driver').ZWaveDriver} opts.zwaveDriver
     * @param {import('../../bridge/node-registry').NodeRegistry}  opts.nodeRegistry
     * @param {import('../../mqtt/client').MqttClient}             opts.mqttClient
     */
    constructor({ zwaveDriver, nodeRegistry, mqttClient }) {
        this._driver = zwaveDriver;
        this._registry = nodeRegistry;
        this._mqtt = mqttClient;

        this._driver.on('node-value-updated', (ev) => this._onValueUpdated(ev));
        this._driver.on('node-status-changed', (ev) => this._onStatusChanged(ev));
        this._driver.on('connected', () => this._onDriverConnected());
        this._driver.on('disconnected', () => this._onDriverDisconnected());

        // Publish schemas at startup. If MQTT isn't connected yet, the driver
        // 'connected' handler will republish; we skip quietly here to avoid a
        // noisy warning during the common startup race.
        this._publishAllSchemas();
    }

    // --- Driver lifecycle ---

    _onDriverConnected() {
        // Mark all Z-Wave configured nodes as 'interviewing' until we get a status update.
        for (const entry of this._registry.getAll()) {
            if (entry.radio === 'zwave') {
                this._registry.setStatus(entry.label, 'interviewing');
            }
        }
        // Re-publish schemas in case the broker was unavailable at startup.
        this._publishAllSchemas();
    }

    _onDriverDisconnected() {
        for (const entry of this._registry.getAll()) {
            if (entry.radio === 'zwave') {
                const { changed: reachableChanged } = this._registry.updateSignal(entry.label, 'reachable', false);
                const statusChanged = this._registry.setStatus(entry.label, 'offline');
                if (reachableChanged || statusChanged) this._publishState(entry.label);
            }
        }
    }

    // --- Per-node events ---

    _onStatusChanged({ nodeId, status }) {
        const entry = this._registry.getByZWaveId(nodeId);
        if (!entry) {
            logger.debug(`Signal zwave-node-${nodeId} status=${status} (unconfigured)`);
            return;
        }
        const prev = entry.status;
        const statusChanged = this._registry.setStatus(entry.label, status);

        // Map zwave-js node status → reachable signal.
        const reachable = !(status === 'dead' || status === 'failed' || status === 'offline');
        const { changed: reachableChanged } = this._registry.updateSignal(entry.label, 'reachable', reachable);

        if (statusChanged || reachableChanged) {
            logger.info(`Node "${entry.label}" (zwave-node-${nodeId}) status → ${status} (reachable=${reachable})`);
            this._publishState(entry.label);
            this._emitLifecycleWarning(entry, prev, status);
        }
    }

    _emitLifecycleWarning(entry, prev, next) {
        if (next === 'failed' && prev !== 'failed') {
            this._publishNodeWarning(entry, {
                severity: 'error',
                code: 'NODE_FAILED',
                message: `Node ${entry.label} reported failed`,
                context: { node_id: entry.node_id, previous_status: prev },
            });
        } else if (prev === 'failed' && (next === 'ready' || next === 'alive')) {
            this._publishNodeWarning(entry, {
                severity: 'info',
                code: 'NODE_RECOVERED',
                message: `Node ${entry.label} recovered`,
                context: { node_id: entry.node_id },
            });
        }
    }

    _publishNodeWarning(entry, { severity, code, message, context }) {
        const topic = nodeTopics(entry.base_topic).warnings;
        this._mqtt.publish(topic, {
            timestamp: new Date().toISOString(),
            severity,
            code,
            message,
            context: { label: entry.label, ...context },
        }, { retain: false });
    }

    _onValueUpdated({ nodeId, commandClass, property, propertyKey, newValue }) {
        const entry = this._registry.getByZWaveId(nodeId);
        const propertyLabel = propertyKey === undefined ? property : `${property}:${propertyKey}`;
        const rawValue = JSON.stringify(newValue);

        if (!entry) {
            logger.debug(
                `Signal zwave-node-${nodeId} CC=${commandClass} property=${propertyLabel} value=${rawValue} (unconfigured)`
            );
            return;
        }

        logger.debug(
            `Signal zwave-node-${nodeId} node=${entry.label} CC=${commandClass} property=${propertyLabel} value=${rawValue} (configured)`
        );

        // --- Battery CC (128) → battery signal ---
        const batteryLevel = normalizeBattery(commandClass, property, newValue);
        if (batteryLevel !== null) {
            const { changed } = this._registry.updateSignal(entry.label, 'battery', batteryLevel);
            if (changed) {
                logger.info(`Node "${entry.label}" battery → ${batteryLevel}%`);
                this._publishState(entry.label);
            }
            return;
        }

        // --- Contact CC normalization ---
        if (entry.type !== 'contact') {
            logger.debug(`Node "${entry.label}" type=${entry.type} — signal observed but not published in phase 1`);
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
        const ts = new Date().toISOString();
        // Internal contact signal uses past-tense "opened"/"closed" for state; events keep verb-form "open"/"close".
        const contactState = normalized === 'open' ? 'opened' : 'closed';

        const { changed } = this._registry.updateSignal(entry.label, 'contact', contactState);
        this._registry.setLastEvent(entry.label, { event: normalized, ts, source });
        this._registry.setSource(entry.label, source);

        if (changed) {
            logger.info(`Node "${entry.label}" contact → ${contactState}`);
            this._publishEvent(entry.label, { event: normalized });
            this._publishState(entry.label);
        } else {
            logger.debug(`Node "${entry.label}" contact ${contactState} (no change — not republished)`);
        }
    }

    // --- MQTT publish helpers ---

    _publishEvent(label, payload) {
        const entry = this._registry.getByLabel(label);
        if (!entry) return;
        const topics = nodeTopics(entry.base_topic);
        this._mqtt.publish(topics.events, payload, { retain: true });
        logger.debug(`MQTT publish ${topics.events} ${JSON.stringify(payload)}`);
    }

    _publishState(label) {
        const entry = this._registry.getByLabel(label);
        if (!entry) return;
        const topics = nodeTopics(entry.base_topic);
        const state = this._buildStatePayload(entry);
        this._mqtt.publish(topics.state, state, { retain: true });
        logger.debug(`MQTT publish ${topics.state} ${JSON.stringify(state)}`);
    }

    /**
     * Build the flat state payload for a node. Shape:
     * {
     *   "state":      "open" | "closed" | null,   // contact-type nodes only
     *   "ts":         iso8601 | null,             // ts of last event producing `state`
     *   "battery":    { "level": 0-100, "ts": iso8601 } | null,
     *   "reachable":  { "value": bool, "ts": iso8601 } | null,
     *   "tamper":     { "active": bool, "ts": iso8601 } | null,
     *   "source":     "zwave-node-N" | null
     * }
     */
    _buildStatePayload(entry) {
        const signals = entry.signals || {};
        const out = {
            state: signals.contact ? signals.contact.value : null,
            ts: signals.contact ? signals.contact.ts : null,
            battery: signals.battery
                ? { level: signals.battery.value, ts: signals.battery.ts }
                : null,
            reachable: signals.reachable
                ? { value: signals.reachable.value, ts: signals.reachable.ts }
                : null,
            tamper: signals.tamper
                ? { active: signals.tamper.value, ts: signals.tamper.ts }
                : null,
            source: entry.source || (entry.node_id ? `zwave-node-${entry.node_id}` : null),
        };
        // Drop `state`/`ts` for non-contact types so the payload isn't misleading.
        if (entry.type !== 'contact') {
            delete out.state;
            delete out.ts;
        }
        return out;
    }

    // --- Schema ---

    _publishAllSchemas() {
        // Defer quietly if MQTT isn't ready; driver 'connected' will retry.
        if (typeof this._mqtt.isConnected === 'function' && !this._mqtt.isConnected()) return;
        for (const entry of this._registry.getAll()) {
            if (entry.radio === 'zwave') this._publishSchema(entry);
        }
    }

    _publishSchema(entry) {
        const topics = nodeTopics(entry.base_topic);
        const schema = {
            application: 'pzb',
            label: entry.label,
            radio: entry.radio,
            type: entry.type,
            node_id: entry.node_id,
            topics: {
                events: topics.events,
                state: topics.state,
                commands: topics.commands,
                warnings: topics.warnings,
            },
            event_values: entry.type === 'contact' ? ['open', 'close'] : [],
            state_fields: {
                state: entry.type === 'contact' ? "'opened' | 'closed' | null" : undefined,
                ts: 'iso8601 | null',
                battery: "{ level: 0-100, ts: iso8601 } | null",
                reachable: "{ value: boolean, ts: iso8601 } | null",
                tamper: "{ active: boolean, ts: iso8601 } | null",
                source: "'zwave-node-N' | null",
            },
            retention: { events: true, state: true, schema: true },
        };
        // Strip undefined state_fields entries for cleanliness.
        for (const k of Object.keys(schema.state_fields)) {
            if (schema.state_fields[k] === undefined) delete schema.state_fields[k];
        }
        this._mqtt.publish(topics.schema, schema, { retain: true });
        logger.info(`MQTT publish ${topics.schema} (schema for "${entry.label}")`);
    }

    /** Public: force-publish the current state for the given registry entry. */
    publishNodeState(entry) {
        if (!entry) return;
        this._publishState(entry.label);
    }
}

module.exports = { ZWaveEvents };
