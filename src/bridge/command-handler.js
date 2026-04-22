'use strict';

const logger = require('../util/logger');
const { bridgeTopics } = require('../mqtt/contract');

/**
 * BridgeCommandHandler — subscribes to `{baseTopic}/pzb/commands` and routes
 * incoming command payloads to registered handlers.
 *
 * Phase 1 commands implemented here:
 *   getNetworkStatus — force-publish pzb/status immediately
 *
 * Unknown commands produce a bridge warning.
 */
class BridgeCommandHandler {
    /**
     * @param {object} opts
     * @param {import('../mqtt/client').MqttClient} opts.mqttClient
     * @param {string}   opts.baseTopic
     * @param {Function} opts.getStatus   - () => statusObject (same fn used by heartbeat)
     * @param {Function} opts.publishWarning - (w) => void
     */
    constructor({ mqttClient, baseTopic, getStatus, publishWarning }) {
        this._mqtt     = mqttClient;
        this._topics   = bridgeTopics(baseTopic);
        this._getStatus     = getStatus;
        this._publishWarning = publishWarning;

        this._mqtt.subscribe(this._topics.commands, (topic, payload) => {
            this._dispatch(payload);
        });

        logger.debug(`Bridge command handler listening on ${this._topics.commands}`);
    }

    _dispatch(payload) {
        if (!payload || typeof payload !== 'object') {
            logger.warn('Bridge command: non-object payload ignored');
            return;
        }

        const { command } = payload;
        if (!command) {
            logger.warn('Bridge command: missing "command" field');
            return;
        }

        logger.debug(`Bridge command received: ${command}`);

        switch (command) {
            case 'getNetworkStatus':
                this._handleGetNetworkStatus();
                break;

            default:
                logger.warn(`Bridge command: unknown command "${command}"`);
                this._publishWarning({
                    severity: 'warn',
                    code:     'UNKNOWN_BRIDGE_COMMAND',
                    message:  `Unknown bridge command: ${command}`,
                    context:  { command },
                });
        }
    }

    _handleGetNetworkStatus() {
        const status = this._getStatus();
        this._mqtt.publish(this._topics.status, status, { retain: true });
        logger.info('Bridge command getNetworkStatus: status published');
    }
}

module.exports = { BridgeCommandHandler };
