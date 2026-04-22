'use strict';

const mqtt = require('mqtt');
const logger = require('../util/logger');

class MqttClient {
    constructor(mqttConfig) {
        this._cfg = mqttConfig;
        this._client = null;
        this._ready = false;
        this._handlers = []; // { topic, fn }
    }

    /**
     * Connect and wait for the first 'connect' event.
     * Resolves when connected, rejects on first error before connect.
     */
    connect() {
        return new Promise((resolve, reject) => {
            const { broker, port, client_id, username, password, keepalive } = this._cfg;
            const url = `mqtt://${broker}:${port}`;

            const opts = {
                clientId: client_id,
                keepalive: keepalive,
                clean: true,
            };
            if (username) opts.username = username;
            if (password) opts.password = password;

            const client = mqtt.connect(url, opts);

            const onError = (err) => {
                if (!this._ready) {
                    client.removeListener('connect', onConnect);
                    reject(err);
                } else {
                    logger.error(`MQTT error: ${err.message}`);
                }
            };

            const onConnect = () => {
                client.removeListener('error', onError);
                this._ready = true;
                logger.info(`MQTT connected to ${url} as ${client_id}`);

                // Re-subscribe after reconnect
                client.on('reconnect', () => logger.warn('MQTT reconnecting…'));
                client.on('offline', () => { this._ready = false; logger.warn('MQTT offline'); });
                client.on('connect', () => { this._ready = true; logger.info('MQTT reconnected'); this._resubscribe(); });
                client.on('message', this._dispatch.bind(this));

                resolve();
            };

            client.once('connect', onConnect);
            client.once('error', onError);

            this._client = client;
        });
    }

    /**
     * Publish a message. Retained flag and QoS come from caller.
     */
    publish(topic, payload, opts = {}) {
        if (!this._client || !this._ready) {
            logger.warn(`MQTT publish skipped (not connected): ${topic}`);
            return;
        }
        const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const options = { qos: this._cfg.mqtt_qos ?? 0, retain: false, ...opts };
        this._client.publish(topic, msg, options);
    }

    /**
     * Subscribe and register a message handler.
     */
    subscribe(topic, fn) {
        this._handlers.push({ topic, fn });
        if (this._client && this._ready) {
            this._client.subscribe(topic, { qos: this._cfg.mqtt_qos ?? 0 });
        }
    }

    _resubscribe() {
        for (const { topic } of this._handlers) {
            this._client.subscribe(topic, { qos: this._cfg.mqtt_qos ?? 0 });
        }
    }

    _dispatch(topic, message) {
        let parsed;
        try {
            parsed = JSON.parse(message.toString());
        } catch {
            parsed = message.toString();
        }
        for (const { topic: pattern, fn } of this._handlers) {
            if (topicMatch(pattern, topic)) fn(topic, parsed);
        }
    }

    async disconnect() {
        if (!this._client) return;
        return new Promise((resolve) => this._client.end(false, {}, resolve));
    }
}

/**
 * Minimal MQTT wildcard topic matcher.
 * Handles '+' (single level) and '#' (multi-level, must be last).
 */
function topicMatch(pattern, topic) {
    const pp = pattern.split('/');
    const tp = topic.split('/');
    for (let i = 0; i < pp.length; i++) {
        if (pp[i] === '#') return true;
        if (pp[i] === '+') continue;
        if (tp[i] === undefined) return false;
        if (pp[i] !== tp[i]) return false;
    }
    return pp.length === tp.length;
}

module.exports = { MqttClient };
