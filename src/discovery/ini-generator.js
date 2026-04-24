'use strict';

/**
 * Build an INI fragment describing a freshly-included radio device.
 *
 * Operators edit the fragment to add their own label, base_topic, and
 * friendly description before merging it into the main pzb.ini.
 *
 * Supports both Z-Wave nodes (from `zwave-js`) and Zigbee devices (from
 * `zigbee-herdsman`).
 */

/**
 * Guess a reasonable `type` based on supported command classes.
 * @param {object} node  zwave-js Node
 */
function guessType(node) {
    try {
        const cc = node.commandClasses || {};
        // Prefer Binary Switch (CC 37) → relay
        if (cc['Binary Switch'] && node.supportsCC?.(37)) return 'relay';
        if (cc['Notification'] && node.supportsCC?.(113)) return 'contact';
        if (cc['Multilevel Switch'] && node.supportsCC?.(38)) return 'switch';
    } catch (_) { /* best-effort */ }
    return 'custom';
}

/**
 * Guess the PZB `type` for a Zigbee device by inspecting exposed clusters.
 * Preference order: relay (genOnOff input cluster) → contact (ssIasZone) → custom.
 */
function guessZigbeeType(device) {
    try {
        const endpoints = Array.isArray(device.endpoints) ? device.endpoints : [];
        for (const ep of endpoints) {
            const inputs = (ep.inputClusters || []).map(toClusterName);
            const outputs = (ep.outputClusters || []).map(toClusterName);
            if (inputs.includes('ssIasZone')) return 'contact';
            if (inputs.includes('genOnOff')) return 'relay';
            if (outputs.includes('genOnOff')) return 'relay';
        }
    } catch (_) { /* best-effort */ }
    return 'custom';
}

function toClusterName(raw) {
    // herdsman endpoint lists clusters as integer IDs; map the handful PZB cares about.
    if (typeof raw === 'string') return raw;
    const CL = {
        0: 'genBasic',
        1: 'genPowerCfg',
        6: 'genOnOff',
        8: 'genLevelCtrl',
        1280: 'ssIasZone',
    };
    return CL[raw] || String(raw);
}

/**
 * Describe a node for discovery purposes.
 * @param {object} node  zwave-js Node
 * @returns {object} plain descriptor (safe to JSON.stringify)
 */
function describeNode(node) {
    return {
        node_id: node.id,
        manufacturer_id: node.manufacturerId ?? null,
        product_type: node.productType ?? null,
        product_id: node.productId ?? null,
        device_class_generic: node.deviceClass?.generic?.label ?? null,
        device_class_specific: node.deviceClass?.specific?.label ?? null,
        label: node.label ?? null,
        guessed_type: guessType(node),
    };
}

/**
 * Describe a Zigbee device for discovery purposes.
 * @param {object} device  zigbee-herdsman Device
 */
function describeZigbeeDevice(device) {
    const ieee = normalizeIeee(device.ieeeAddr);
    return {
        ieee,
        network_address: device.networkAddress ?? null,
        manufacturer_name: device.manufacturerName ?? null,
        model_id: device.modelID ?? device.modelId ?? null,
        power_source: device.powerSource ?? null,
        endpoint_count: Array.isArray(device.endpoints) ? device.endpoints.length : 0,
        guessed_type: guessZigbeeType(device),
    };
}

/**
 * Build an INI fragment for operator review.
 * @param {object} node  zwave-js Node
 * @param {object} [opts]
 * @param {string} [opts.labelPrefix='discovered']
 * @param {string} [opts.baseTopicHint]
 */
function buildIniFragment(node, opts = {}) {
    const prefix = opts.labelPrefix || 'discovered';
    const label = `${prefix}-${node.id}`;
    const type = guessType(node);
    const desc = describeNode(node);

    const header = [
        `; ---- Discovered ${new Date().toISOString()} ----`,
        `; Node ID: ${desc.node_id}`,
        `; Manufacturer: 0x${(desc.manufacturer_id ?? 0).toString(16).padStart(4, '0')}`,
        `; Product type/id: 0x${(desc.product_type ?? 0).toString(16).padStart(4, '0')} / 0x${(desc.product_id ?? 0).toString(16).padStart(4, '0')}`,
        `; Device class: ${desc.device_class_generic || '?'} / ${desc.device_class_specific || '?'}`,
        `; Label: ${desc.label || '(none)'}`,
    ].join('\n');

    const baseTopic = opts.baseTopicHint
        || `TODO: replace with e.g. paradox/<room>/zwave/${label}`;

    const body = [
        `[node:${label}]`,
        `radio       = zwave`,
        `node_id     = ${node.id}`,
        `type        = ${type}${type === 'custom' ? '      ; TODO: set to contact|relay|switch|motion' : ''}`,
        `base_topic  = ${baseTopic}`,
        `description = TODO: add a friendly description`,
        '',
    ].join('\n');

    return `${header}\n${body}`;
}

/**
 * Build an INI fragment for a newly-joined Zigbee device.
 * @param {object} device  zigbee-herdsman Device
 * @param {object} [opts]
 * @param {string} [opts.labelPrefix='discovered']
 * @param {string} [opts.baseTopicHint]
 */
function buildZigbeeIniFragment(device, opts = {}) {
    const prefix = opts.labelPrefix || 'discovered';
    const ieee = normalizeIeee(device.ieeeAddr);
    const tail = ieee ? ieee.slice(-4) : 'xxxx';
    const label = `${prefix}-${tail}`;
    const type = guessZigbeeType(device);
    const desc = describeZigbeeDevice(device);

    const header = [
        `; ---- Discovered ${new Date().toISOString()} ----`,
        `; IEEE: ${desc.ieee}`,
        `; Network address: ${desc.network_address ?? '?'}`,
        `; Manufacturer: ${desc.manufacturer_name || '(none)'}`,
        `; Model: ${desc.model_id || '(none)'}`,
        `; Power: ${desc.power_source || '(unknown)'}`,
    ].join('\n');

    const baseTopic = opts.baseTopicHint
        || `TODO: replace with e.g. paradox/<room>/zigbee/${label}`;

    const body = [
        `[node:${label}]`,
        `radio       = zigbee`,
        `ieee        = ${desc.ieee}`,
        `type        = ${type}${type === 'custom' ? '      ; TODO: set to contact|relay|switch|motion' : ''}`,
        `base_topic  = ${baseTopic}`,
        `description = TODO: add a friendly description`,
        '',
    ].join('\n');

    return `${header}\n${body}`;
}

function normalizeIeee(raw) {
    if (!raw) return null;
    const s = String(raw).trim().toLowerCase().replace(/^0x/, '').replace(/[^0-9a-f]/g, '');
    if (!s) return null;
    return `0x${s.padStart(16, '0')}`;
}

module.exports = {
    buildIniFragment,
    buildZigbeeIniFragment,
    describeNode,
    describeZigbeeDevice,
    guessType,
    guessZigbeeType,
};
