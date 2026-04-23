'use strict';

/**
 * Build an INI fragment describing a freshly-included Z-Wave node.
 *
 * Operators edit the fragment to add their own label, base_topic, and
 * friendly description before merging it into the main pzb.ini.
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

module.exports = { buildIniFragment, describeNode, guessType };
