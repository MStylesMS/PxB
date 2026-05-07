'use strict';

const logger = require('../../util/logger');

/**
 * Low-level Zigbee command helpers (On/Off cluster).
 *
 * Mirrors `radios/zwave/commands.js`. Higher-level policy (MQTT routing, state
 * echo) lives in the bridge's NodeCommandHandler.
 */

/**
 * Resolve the first controllable endpoint on a device.
 * Prefers endpoint 1 (standard lighting/relay control endpoint).
 */
function selectControllableEndpoint(device) {
    if (!device) return null;
    const endpoints = Array.isArray(device.endpoints) ? device.endpoints
        : (typeof device.getEndpoints === 'function' ? device.getEndpoints() : []);
    if (!endpoints || endpoints.length === 0) return null;
    const preferred = endpoints.find((ep) => ep && (ep.ID === 1 || ep.id === 1));
    if (preferred) return preferred;
    return endpoints.find((ep) => ep && typeof ep.command === 'function') || null;
}

/**
 * Resolve a herdsman Device from a live ZigbeeDriver, or throw.
 */
function resolveDevice(zigbeeDriver, ieee) {
    if (!zigbeeDriver || !zigbeeDriver.connected) {
        const err = new Error('Zigbee driver not connected');
        err.code = 'ZIGBEE_NOT_READY';
        throw err;
    }
    const device = zigbeeDriver.getDeviceByIeee(ieee);
    if (!device) {
        const err = new Error(`Zigbee device ${ieee} not found`);
        err.code = 'NODE_NOT_FOUND';
        throw err;
    }
    return device;
}

/**
 * Send an On/Off cluster command (`on` | `off` | `toggle`).
 */
async function setOnOff(zigbeeDriver, ieee, value) {
    const device = resolveDevice(zigbeeDriver, ieee);
    const endpoint = selectControllableEndpoint(device);
    if (!endpoint || typeof endpoint.command !== 'function') {
        const err = new Error(`Zigbee device ${ieee} has no controllable endpoint`);
        err.code = 'COMMAND_UNSUPPORTED';
        throw err;
    }
    const action = value === true || value === 'on' ? 'on'
        : value === false || value === 'off' ? 'off'
            : 'toggle';
    logger.debug(`Zigbee setOnOff ieee=${ieee} → ${action}`);
    await endpoint.command('genOnOff', action, {}, { disableDefaultResponse: true });
    return true;
}

/**
 * Pulse an on/off endpoint: on → delay(ms) → off.
 */
async function pulseOnOff(zigbeeDriver, ieee, durationMs) {
    const ms = Math.max(50, Math.min(Number(durationMs) || 500, 30_000));
    await setOnOff(zigbeeDriver, ieee, true);
    await new Promise((r) => {
        const t = setTimeout(r, ms);
        if (typeof t.unref === 'function') t.unref();
    });
    await setOnOff(zigbeeDriver, ieee, false);
    return true;
}

module.exports = { setOnOff, pulseOnOff, resolveDevice, selectControllableEndpoint };
