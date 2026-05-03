'use strict';

const logger = require('../util/logger');
const { bridgeTopics } = require('../mqtt/contract');

/**
 * BridgeCommandHandler — subscribes to `{baseTopic}/pxb/commands` and routes
 * incoming command payloads to registered handlers.
 *
 * Supported commands:
 *   getNetworkStatus   — publish pxb/state immediately
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
     * @param {import('../radios/zigbee/inclusion').ZigbeeInclusion} [opts.zigbeeInclusion]
     * @param {import('../radios/zigbee/driver').ZigbeeDriver}       [opts.zigbeeDriver]
     * @param {import('./node-registry').NodeRegistry}              [opts.nodeRegistry]
     */
    constructor({
        mqttClient, baseTopic, getStatus, publishWarning,
        zwaveInclusion = null, zwaveDriver = null,
        zigbeeInclusion = null, zigbeeDriver = null,
        nodeRegistry = null,
    }) {
        this._mqtt = mqttClient;
        this._topics = bridgeTopics(baseTopic);
        this._getStatus = getStatus;
        this._publishWarning = publishWarning;
        this._inclusion = zwaveInclusion;
        this._zwaveDriver = zwaveDriver;
        this._zigbeeInclusion = zigbeeInclusion;
        this._zigbeeDriver = zigbeeDriver;
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
                return this._handleStopInclusion(payload);
            case 'startExclusion':
                return this._handleStartExclusion(payload);
            case 'stopExclusion':
                return this._handleStopExclusion(payload);
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

    /** Resolve an inclusion FSM by radio name; returns null + warning on miss. */
    _resolveInclusion(radio) {
        const r = (radio || 'zwave').toLowerCase();
        if (r === 'zigbee') {
            if (!this._zigbeeInclusion) {
                this._publishWarning({
                    severity: 'warn', code: 'ZIGBEE_DISABLED',
                    message: 'Zigbee inclusion is not available',
                    context: { radio: 'zigbee' },
                });
                return null;
            }
            return { fsm: this._zigbeeInclusion, radio: 'zigbee' };
        }
        if (!this._inclusion) {
            this._publishWarning({
                severity: 'warn', code: 'ZWAVE_DISABLED',
                message: 'Z-Wave inclusion is not available',
                context: { radio: 'zwave' },
            });
            return null;
        }
        return { fsm: this._inclusion, radio: 'zwave' };
    }

    async _handleStartInclusion(payload) {
        const resolved = this._resolveInclusion(payload.radio);
        if (!resolved) return;
        const timeoutMs = payload.timeout_s ? Number(payload.timeout_s) * 1000 : undefined;
        const strategy = payload.strategy != null ? Number(payload.strategy) : undefined;
        const accepted = await resolved.fsm.startInclusion({ timeoutMs, strategy });
        if (accepted) {
            this._publishWarning({
                severity: 'info',
                code: 'INCLUSION_STARTED',
                message: 'Inclusion started',
                context: { radio: resolved.radio, timeout_ms: timeoutMs || null, strategy: strategy ?? null },
            });
        }
    }

    async _handleStopInclusion(payload = {}) {
        const resolved = this._resolveInclusion(payload.radio);
        if (!resolved) return;
        await resolved.fsm.stopInclusion();
        this._publishWarning({
            severity: 'info',
            code: 'INCLUSION_STOPPED',
            message: 'Inclusion stopped',
            context: { radio: resolved.radio },
        });
    }

    async _handleStartExclusion(payload) {
        const resolved = this._resolveInclusion(payload.radio);
        if (!resolved) return;
        const timeoutMs = payload.timeout_s ? Number(payload.timeout_s) * 1000 : undefined;
        const accepted = await resolved.fsm.startExclusion({ timeoutMs });
        if (accepted) {
            this._publishWarning({
                severity: 'info',
                code: 'EXCLUSION_STARTED',
                message: 'Exclusion started',
                context: { radio: resolved.radio, timeout_ms: timeoutMs || null },
            });
        }
    }

    async _handleStopExclusion(payload = {}) {
        const resolved = this._resolveInclusion(payload.radio);
        if (!resolved) return;
        await resolved.fsm.stopExclusion();
        this._publishWarning({
            severity: 'info',
            code: 'EXCLUSION_STOPPED',
            message: 'Exclusion stopped',
            context: { radio: resolved.radio },
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

    _resolveZigbeeNode(payload) {
        if (!this._zigbeeDriver || !this._zigbeeDriver.connected) {
            this._publishWarning({
                severity: 'warn',
                code: 'ZIGBEE_NOT_READY',
                message: 'Zigbee coordinator not connected',
                context: {},
            });
            return null;
        }
        let ieee = payload.ieee;
        if (!ieee && payload.label && this._registry) {
            const entry = this._registry.getByLabel(payload.label);
            if (entry && entry.radio === 'zigbee') ieee = entry.ieee;
        }
        if (!ieee) {
            this._publishWarning({
                severity: 'warn',
                code: 'BAD_COMMAND',
                message: 'refreshNode/removeFailedNode (zigbee) requires ieee or known label',
                context: { payload },
            });
            return null;
        }
        const device = this._zigbeeDriver.getDeviceByIeee(ieee);
        if (!device) {
            this._publishWarning({
                severity: 'warn',
                code: 'NODE_NOT_FOUND',
                message: `Zigbee device ${ieee} not found`,
                context: { ieee },
            });
            return null;
        }
        return { ieee, device };
    }

    _pickRadio(payload) {
        if (payload && payload.radio) return String(payload.radio).toLowerCase();
        // Infer from payload fields: ieee → zigbee; node_id → zwave.
        if (payload && payload.ieee) return 'zigbee';
        if (payload && payload.node_id) return 'zwave';
        if (payload && payload.label && this._registry) {
            const entry = this._registry.getByLabel(payload.label);
            if (entry) return entry.radio;
        }
        return 'zwave';
    }

    async _handleRefreshNode(payload) {
        const radio = this._pickRadio(payload);
        if (radio === 'zigbee') {
            const resolved = this._resolveZigbeeNode(payload);
            if (!resolved) return;
            try {
                // Best effort: re-interview the device if the API is available.
                if (typeof resolved.device.interview === 'function') {
                    await resolved.device.interview();
                } else if (typeof resolved.device.ping === 'function') {
                    await resolved.device.ping();
                }
                logger.info(`refreshNode: zigbee ${resolved.ieee} refresh requested`);
            } catch (err) {
                this._publishWarning({
                    severity: 'error',
                    code: 'REFRESH_FAILED',
                    message: err.message,
                    context: { ieee: resolved.ieee, radio: 'zigbee' },
                });
            }
            return;
        }
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
                context: { node_id: resolved.nodeId, radio: 'zwave' },
            });
        }
    }

    async _handleRemoveFailedNode(payload) {
        const radio = this._pickRadio(payload);
        if (radio === 'zigbee') {
            const resolved = this._resolveZigbeeNode(payload);
            if (!resolved) return;
            try {
                if (typeof resolved.device.removeFromNetwork === 'function') {
                    await resolved.device.removeFromNetwork();
                } else if (typeof this._zigbeeDriver.controller.removeDevice === 'function') {
                    await this._zigbeeDriver.controller.removeDevice(resolved.ieee);
                } else if (typeof resolved.device.removeFromDatabase === 'function') {
                    await resolved.device.removeFromDatabase();
                } else {
                    throw new Error('removeDevice is not supported by this zigbee-herdsman version');
                }
                logger.info(`removeFailedNode: zigbee ${resolved.ieee} removed`);
            } catch (err) {
                this._publishWarning({
                    severity: 'error',
                    code: 'REMOVE_FAILED',
                    message: err.message,
                    context: { ieee: resolved.ieee, radio: 'zigbee' },
                });
            }
            return;
        }
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
                context: { node_id: resolved.nodeId, radio: 'zwave' },
            });
        }
    }
}

module.exports = { BridgeCommandHandler };
