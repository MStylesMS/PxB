'use strict';

const logger = require('../../util/logger');
const { normalizeZigbeeContact, normalizeZigbeeBattery } = require('../../bridge/normalizer');
const { nodeTopics } = require('../../mqtt/contract');

/**
 * ZigbeeEvents — mirrors `ZWaveEvents` for the Zigbee radio.
 *
 * Listens to `zigbee-message`, `zigbee-device-announce`, `zigbee-device-left`,
 * `zigbee-device-interview`, and `zigbee-device-joined` from ZigbeeDriver,
 * normalizes payloads, updates the NodeRegistry, and publishes retained
 * per-node events + state messages only when telemetry actually changes.
 *
 * Also publishes a retained per-node `schema` message once per configured
 * node on construction (and again on controller reconnect).
 */
class ZigbeeEvents {
    /**
     * @param {object} opts
     * @param {import('../zigbee/driver').ZigbeeDriver} opts.zigbeeDriver
     * @param {import('../../bridge/node-registry').NodeRegistry} opts.nodeRegistry
     * @param {import('../../mqtt/client').MqttClient} opts.mqttClient
     */
    constructor({ zigbeeDriver, nodeRegistry, mqttClient }) {
        this._driver = zigbeeDriver;
        this._registry = nodeRegistry;
        this._mqtt = mqttClient;

        this._driver.on('zigbee-message', (ev) => this._onMessage(ev));
        this._driver.on('zigbee-device-announce', ({ ieee }) => this._onReachable(ieee, true));
        this._driver.on('zigbee-device-left', ({ ieee }) => this._onReachable(ieee, false));
        this._driver.on('zigbee-device-interview', (ev) => this._onInterview(ev));
        this._driver.on('connected', () => this._onDriverConnected());
        this._driver.on('disconnected', () => this._onDriverDisconnected());

        this._publishAllSchemas();
    }

    _onDriverConnected() {
        for (const entry of this._registry.getAll()) {
            if (entry.radio === 'zigbee') {
                this._registry.setStatus(entry.label, 'interviewing');
            }
        }
        this._publishAllSchemas();
    }

    _onDriverDisconnected() {
        for (const entry of this._registry.getAll()) {
            if (entry.radio === 'zigbee') {
                const { changed: reachableChanged } = this._registry.updateSignal(entry.label, 'reachable', false);
                const statusChanged = this._registry.setStatus(entry.label, 'offline');
                if (reachableChanged || statusChanged) this._publishState(entry.label);
            }
        }
    }

    _onInterview({ ieee, status }) {
        const entry = this._registry.getByIeee(ieee);
        if (!entry) {
            logger.debug(`Zigbee device ${ieee} interview=${status} (unconfigured)`);
            return;
        }
        const prev = entry.status;
        let next = prev;
        if (status === 'started') next = 'interviewing';
        else if (status === 'successful') next = 'ready';
        else if (status === 'failed') next = 'failed';

        const statusChanged = this._registry.setStatus(entry.label, next);
        const reachable = next !== 'failed' && next !== 'offline';
        const { changed: reachableChanged } = this._registry.updateSignal(entry.label, 'reachable', reachable);

        if (statusChanged || reachableChanged) {
            logger.info(`Node "${entry.label}" (zigbee:${ieee}) status → ${next}`);
            this._publishState(entry.label);
            this._emitLifecycleWarning(entry, prev, next);
        }
    }

    _onReachable(ieee, reachable) {
        const entry = this._registry.getByIeee(ieee);
        if (!entry) return;
        const { changed } = this._registry.updateSignal(entry.label, 'reachable', reachable);
        if (!reachable) this._registry.setStatus(entry.label, 'offline');
        if (changed) this._publishState(entry.label);
    }

    _emitLifecycleWarning(entry, prev, next) {
        if (next === 'failed' && prev !== 'failed') {
            this._publishNodeWarning(entry, {
                severity: 'error',
                code: 'NODE_FAILED',
                message: `Node ${entry.label} reported failed`,
                context: { ieee: entry.ieee, previous_status: prev },
            });
        } else if (prev === 'failed' && next === 'ready') {
            this._publishNodeWarning(entry, {
                severity: 'info',
                code: 'NODE_RECOVERED',
                message: `Node ${entry.label} recovered`,
                context: { ieee: entry.ieee },
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

    _onMessage({ ieee, cluster, type, data, endpointId }) {
        const entry = this._registry.getByIeee(ieee);
        if (!entry) {
            logger.debug(`Zigbee msg ${ieee} cluster=${cluster} type=${type} (unconfigured)`);
            return;
        }

        logger.debug(`Zigbee msg node=${entry.label} ieee=${ieee} cluster=${cluster} type=${type}`);

        // Any inbound message implies the device is reachable.
        this._registry.updateSignal(entry.label, 'reachable', true);

        // --- Battery ---
        const battery = normalizeZigbeeBattery(cluster, type, data);
        if (battery !== null) {
            const { changed } = this._registry.updateSignal(entry.label, 'battery', battery);
            if (changed) {
                logger.info(`Node "${entry.label}" battery → ${battery}%`);
                this._publishState(entry.label);
            }
            return;
        }

        // --- Contact ---
        if (entry.type !== 'contact') {
            logger.debug(`Node "${entry.label}" type=${entry.type} — zigbee message observed but not published (non-contact)`);
            return;
        }

        const normalized = normalizeZigbeeContact(cluster, type, data);
        if (normalized === null) {
            logger.debug(`Node "${entry.label}" zigbee ${cluster}/${type} — not normalizable`);
            return;
        }

        const source = `zigbee-${ieee}`;
        const ts = new Date().toISOString();
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
            source: entry.source || (entry.ieee ? `zigbee-${entry.ieee}` : null),
        };
        if (entry.type !== 'contact') {
            delete out.state;
            delete out.ts;
        }
        return out;
    }

    _publishAllSchemas() {
        if (typeof this._mqtt.isConnected === 'function' && !this._mqtt.isConnected()) return;
        for (const entry of this._registry.getAll()) {
            if (entry.radio === 'zigbee') this._publishSchema(entry);
        }
    }

    _publishSchema(entry) {
        const topics = nodeTopics(entry.base_topic);
        const schema = {
            application: 'pxb',
            label: entry.label,
            radio: entry.radio,
            type: entry.type,
            ieee: entry.ieee,
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
                source: "'zigbee-<ieee>' | null",
            },
            retention: { events: true, state: true, schema: true },
        };
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

module.exports = { ZigbeeEvents };
