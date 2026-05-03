'use strict';

const { bridgeTopics } = require('../mqtt/contract');
const logger = require('../util/logger');

/**
 * Publishes a bridge-level warning JSON to {base_topic}/pxb/warnings.
 *
 * Shape:
 *   { timestamp, severity, code, message, context }
 *
 * Warnings are NOT retained — consumers get them on the wire only.
 */
function publishBridgeWarning(mqttClient, baseTopic, { severity = 'warn', code, message, context = {} }) {
    const topic = bridgeTopics(baseTopic).warnings;
    const payload = {
        timestamp: new Date().toISOString(),
        severity,
        code,
        message,
        context,
    };
    mqttClient.publish(topic, payload, { retain: false });
    const level = severity === 'error'
        ? 'error'
        : (severity === 'info' ? 'info' : 'warn');
    logger[level](`BridgeWarning ${code}: ${message}`);
}

module.exports = { publishBridgeWarning };
