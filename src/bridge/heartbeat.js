'use strict';

const { bridgeTopics } = require('../mqtt/contract');
const logger = require('../util/logger');

class Heartbeat {
    /**
     * @param {object} mqttClient  - MqttClient instance
     * @param {string} baseTopic   - mqtt.base_topic from config
     * @param {number} intervalSec - heartbeat_interval from global config
     * @param {function} getStatus - callback that returns the current bridge status object
     */
    constructor(mqttClient, baseTopic, intervalSec, getStatus) {
        this._mqtt = mqttClient;
        this._topic = bridgeTopics(baseTopic).state;
        this._interval = intervalSec * 1000;
        this._getStatus = getStatus;
        this._timer = null;
    }

    start() {
        if (this._timer) return;
        this._publish();
        this._timer = setInterval(() => {
            try { this._publish(); }
            catch (err) { logger.error(`Heartbeat publish error: ${err.message}`); }
        }, this._interval);
        logger.info(`Heartbeat started — publishing to ${this._topic} every ${this._interval / 1000}s`);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    /** Publish immediately (e.g. on state change or SIGTERM). */
    flush(overrides = {}) {
        this._publish(overrides);
    }

    _publish(overrides = {}) {
        const status = { ...this._getStatus(), ...overrides };
        this._mqtt.publish(this._topic, status, { retain: true });
        logger.debug(`Heartbeat published state=${status.state}`);
    }
}

module.exports = { Heartbeat };
