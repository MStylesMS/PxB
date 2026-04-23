'use strict';

const logger = require('../util/logger');
const { bridgeTopics } = require('../mqtt/contract');

/**
 * BridgeCommandHandler — subscribes to `{baseTopic}/pzb/commands` and routes
 * incoming command payloads to registered handlers.
 *
 * Supported commands:
 *   getNetworkStatus   — publish pzb/state immediately
 *   startInclusion     — begin Z-Wave inclusion (optional: { timeout_s })
 *   stopInclusion      — abort in-progress inclusion
 *   startExclusion     — begin Z-Wave exclusion
 *   stopExclusion      — abort in-progress exclusion
 *   refreshNode        — re-interview a configured node  ({ label } or { node_id })
 *   removeFailedNode   — remove a dead node from the controller  ({ node_id })
 *
 * Unknown commands produce a bridge warning.
 */
class BridgeCommandHandler {
    /**
     * @param {object} opts
     * @param {import('../mqtt/client').MqttClient} opts.mqttClient
     * @param {string}   opts.baseTopic
     * @param {Function} opts.getStatus
     * @param {Function} opts.publishWarning
     * @param {import('../radios/zwave/inclusion').ZWaveInclusion} [opts.zwaveInclusion]
     * @param {import('../radios/zwave/driver').ZWaveDriver}        [opts.zwaveDriver]
     * @param {import('./node-registry').NodeRegistry}              [opts.nodeRegistry]
     */
    constructor({
        mqttClient, baseTopic, getStatus, publishWarning,
        zwaveInclusion = null, zwaveDriver = null, nodeRegistry = null,
    }) {
        this._mqtt = mqttClient;
        this._topics = bridgeTopics(baseTopic);
        this._getStatus = getStatus;
        this._publishWarning = publishWarning;
        this._inclusion = zwaveInclusion;
        this._zwaveDriver = zwaveDriver;
        this._registry = nodeRegistry;

        this._mqtt.subscribe(this._topics.commands, (topic, payload) => {
            this._dispatch(payload).catch((err) => {
                logger.error(`Bridge command dispatch error: ${err.message}`);
            });
        });

        logger.debug(`Bridge command handler listening on ${this._topics.commands}`);
    }

    async _dispatch(payload) {
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
                return this._handleGetNetworkStatus();
            case 'startInclusion':
                return this._handleStartInclusion(payload);
            case 'stopInclusion':
                return this._handleStopInclusion();
            case 'startExclusion':
                return this._handleStartExclusion(payload);
            case 'stopExclusion':
                return this._handleStopExclusion();
            case 'refreshNode':
                return this._handleRefreshNode(payload);
            case 'removeFailedNode':
                return this._handleRemoveFailedNode(payload);
            default:
                logger.warn(`Bridge command: unknown command "${command}"`);
                this._publishWarning({
                    severity: 'warn',
                    code: 'UNKNOWN_BRIDGE_COMMAND',
                    message: `Unknown bridge command: ${command}`,
                    context: { command },
                });
        }
    }

    _handleGetNetworkStatus() {
        const status = this._getStatus();
        this._mqtt.publish(this._topics.state, status, { retain: true });
        logger.info('Bridge command getNetworkStatus: state published');
    }

    _requireInclusion() {
        if (!this._inclusion) {
            this._publishWarning({
                severity: 'warn',
                code: 'ZWAVE_DISABLED',
                message: 'Z-Wave inclusion is not available',
                context: {},
            });
            return false;
        }
        return true;
    }

    async _handleStartInclusion(payload) {
        if (!this._requireInclusion()) return;
        const timeoutMs = payload.timeout_s ? Number(payload.timeout_s) * 1000 : undefined;
        const strategy = payload.strategy != null ? Number(payload.strategy) : undefined;
        const accepted = await this._inclusion.startInclusion({ timeoutMs, strategy });
        if (accepted) {
            this._publishWarning({
                severity: 'info',
                code: 'INCLUSION_STARTED',
                message: 'Inclusion started',
                context: { timeout_ms: timeoutMs || null, strategy: strategy ?? 0 },
            });
        }
    }

    async _handleStopInclusion() {
        if (!this._requireInclusion()) return;
        await this._inclusion.stopInclusion();
        this._publishWarning({
            severity: 'info',
            code: 'INCLUSION_STOPPED',
            message: 'Inclusion stopped',
            context: {},
        });
    }

    async _handleStartExclusion(payload) {
        if (!this._requireInclusion()) return;
        const timeoutMs = payload.timeout_s ? Number(payload.timeout_s) * 1000 : undefined;
        const accepted = await this._inclusion.startExclusion({ timeoutMs });
        if (accepted) {
            this._publishWarning({
                severity: 'info',
                code: 'EXCLUSION_STARTED',
                message: 'Exclusion started',
                context: { timeout_ms: timeoutMs || null },
            });
        }
    }

    async _handleStopExclusion() {
        if (!this._requireInclusion()) return;
        await this._inclusion.stopExclusion();
        this._publishWarning({
            severity: 'info',
            code: 'EXCLUSION_STOPPED',
            message: 'Exclusion stopped',
            context: {},
        });
    }

    _resolveZwaveNode(payload) {
        if (!this._zwaveDriver || !this._zwaveDriver.connected) {
            this._publishWarning({
                severity: 'warn',
                code: 'ZWAVE_NOT_READY',
                message: 'Z-Wave driver not connected',
                context: {},
            });
            return null;
        }
        let nodeId = payload.node_id;
        if (!nodeId && payload.label && this._registry) {
            const entry = this._registry.getByLabel(payload.label);
            if (entry && entry.radio === 'zwave') nodeId = entry.node_id;
        }
        if (!nodeId) {
            this._publishWarning({
                severity: 'warn',
                code: 'BAD_COMMAND',
                message: 'refreshNode/removeFailedNode requires node_id or known label',
                context: { payload },
            });
            return null;
        }
        const node = this._zwaveDriver.controller?.nodes?.get(Number(nodeId));
        if (!node) {
            this._publishWarning({
                severity: 'warn',
                code: 'NODE_NOT_FOUND',
                message: `Z-Wave node ${nodeId} not found`,
                context: { node_id: nodeId },
            });
            return null;
        }
        return { nodeId: Number(nodeId), node };
    }

    async _handleRefreshNode(payload) {
        const resolved = this._resolveZwaveNode(payload);
        if (!resolved) return;
        try {
            await resolved.node.refreshInfo();
            logger.info(`refreshNode: node ${resolved.nodeId} refresh requested`);
        } catch (err) {
            this._publishWarning({
                severity: 'error',
                code: 'REFRESH_FAILED',
                message: err.message,
                context: { node_id: resolved.nodeId },
            });
        }
    }

    async _handleRemoveFailedNode(payload) {
        const resolved = this._resolveZwaveNode(payload);
        if (!resolved) return;
        try {
            await this._zwaveDriver.controller.removeFailedNode(resolved.nodeId);
            logger.info(`removeFailedNode: node ${resolved.nodeId} removed`);
        } catch (err) {
            this._publishWarning({
                severity: 'error',
                code: 'REMOVE_FAILED',
                message: err.message,
                context: { node_id: resolved.nodeId },
            });
        }
    }
}

module.exports = { BridgeCommandHandler };
