'use strict';

const logger = require('../../util/logger');

/**
 * Low-level Z-Wave command helpers.
 *
 * These are thin wrappers around zwave-js Command Class APIs that normalize
 * error handling and logging. Higher-level policy (routing MQTT commands,
 * echoing state) lives in the bridge's NodeCommandHandler.
 */

/**
 * Resolve a zwave-js Node from a live driver, or throw.
 * @param {import('./driver').ZWaveDriver} zwaveDriver
 * @param {number} nodeId
 * @returns {object} zwave-js Node
 */
function resolveNode(zwaveDriver, nodeId) {
    const controller = zwaveDriver.controller;
    if (!controller) {
        const err = new Error('Z-Wave driver not connected');
        err.code = 'ZWAVE_NOT_READY';
        throw err;
    }
    const node = controller.nodes.get(Number(nodeId));
    if (!node) {
        const err = new Error(`Z-Wave node ${nodeId} not found`);
        err.code = 'NODE_NOT_FOUND';
        throw err;
    }
    return node;
}

/**
 * Set a Binary Switch (CC 37) to on/off.
 * @param {import('./driver').ZWaveDriver} zwaveDriver
 * @param {number} nodeId
 * @param {boolean} value
 * @returns {Promise<boolean>} true on apparent success
 */
async function setBinarySwitch(zwaveDriver, nodeId, value) {
    const node = resolveNode(zwaveDriver, nodeId);
    const api = node.commandClasses?.['Binary Switch'];
    if (!api || typeof api.set !== 'function') {
        const err = new Error(`Node ${nodeId} does not support Binary Switch`);
        err.code = 'COMMAND_UNSUPPORTED';
        throw err;
    }
    logger.debug(`Z-Wave setBinarySwitch node=${nodeId} value=${value}`);
    await api.set(Boolean(value));
    return true;
}

/**
 * Pulse a Binary Switch: on → delay(ms) → off.
 * Returns a promise that resolves after the off command completes.
 * @param {import('./driver').ZWaveDriver} zwaveDriver
 * @param {number} nodeId
 * @param {number} durationMs
 */
async function pulseBinarySwitch(zwaveDriver, nodeId, durationMs) {
    const ms = Math.max(50, Math.min(Number(durationMs) || 500, 30_000));
    await setBinarySwitch(zwaveDriver, nodeId, true);
    await new Promise((r) => {
        const t = setTimeout(r, ms);
        if (typeof t.unref === 'function') t.unref();
    });
    await setBinarySwitch(zwaveDriver, nodeId, false);
    return true;
}

module.exports = { setBinarySwitch, pulseBinarySwitch, resolveNode };
