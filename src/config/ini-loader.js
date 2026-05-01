'use strict';

const fs = require('fs');
const path = require('path');
const ini = require('ini');
const { SCHEMA, VALID_NODE_LABEL, VALID_RADIOS, VALID_TYPES } = require('./schema');

/**
 * Parse a string value according to a schema type.
 */
function coerce(key, raw, type) {
    switch (type) {
        case 'int': {
            const n = parseInt(raw, 10);
            if (Number.isNaN(n)) throw new Error(`Key "${key}" must be an integer, got: ${raw}`);
            return n;
        }
        case 'bool':
            if (raw === true || raw === 'true' || raw === '1' || raw === 'yes') return true;
            if (raw === false || raw === 'false' || raw === '0' || raw === 'no') return false;
            throw new Error(`Key "${key}" must be a boolean (true/false), got: ${raw}`);
        case 'path':
        case 'string':
        default:
            return String(raw);
    }
}

/**
 * Apply schema defaults + type coercion to a raw INI section.
 * Returns a clean typed object.
 */
function applySchema(sectionSchema, rawSection, sectionName) {
    const out = {};
    const errors = [];

    for (const [key, def] of Object.entries(sectionSchema)) {
        const raw = rawSection[key];
        if (raw === undefined || raw === null || raw === '') {
            if (def.required) {
                errors.push(`[${sectionName}] missing required key: "${key}"`);
            } else if (def.default !== undefined) {
                out[key] = def.default;
            }
        } else {
            try {
                out[key] = coerce(key, raw, def.type);
            } catch (e) {
                errors.push(`[${sectionName}] ${e.message}`);
            }
        }
    }

    if (errors.length) throw new Error(errors.join('\n'));
    return out;
}

/**
 * Load and validate a PxB INI config file.
 * Returns a structured config object.
 */
function loadConfig(configPath) {
    const absPath = path.resolve(configPath);
    if (!fs.existsSync(absPath)) {
        throw new Error(`Config file not found: ${absPath}`);
    }

    const raw = ini.parse(fs.readFileSync(absPath, 'utf8'));
    const errors = [];
    const config = { nodes: {} };

    // --- [mqtt] (required) ---
    if (!raw.mqtt) {
        errors.push('[mqtt] section is required');
    } else {
        try {
            config.mqtt = applySchema(SCHEMA.mqtt, raw.mqtt, 'mqtt');
        } catch (e) {
            errors.push(e.message);
        }
    }

    // --- [global] (optional) ---
    config.global = {};
    if (raw.global) {
        try {
            config.global = applySchema(SCHEMA.global, raw.global, 'global');
        } catch (e) {
            errors.push(e.message);
        }
    } else {
        // Apply defaults
        for (const [key, def] of Object.entries(SCHEMA.global)) {
            if (def.default !== undefined) config.global[key] = def.default;
        }
    }

    // Resolve discovered_base_topic default (depends on mqtt.base_topic)
    if (!config.global.discovered_base_topic && config.mqtt) {
        config.global.discovered_base_topic = `${config.mqtt.base_topic}/pzb/discovered`;
    }

    // --- [zwave] (optional) ---
    config.zwave = null;
    if (raw.zwave) {
        try {
            config.zwave = applySchema(SCHEMA.zwave, raw.zwave, 'zwave');
            // Default cache_dir relative to config file
            if (!config.zwave.cache_dir) {
                config.zwave.cache_dir = path.join(path.dirname(absPath), 'cache');
            }
        } catch (e) {
            errors.push(e.message);
        }
    }

    // --- [zigbee] (optional) ---
    config.zigbee = null;
    if (raw.zigbee) {
        try {
            config.zigbee = applySchema(SCHEMA.zigbee, raw.zigbee, 'zigbee');
            if (raw.zigbee.adapter !== undefined && String(raw.zigbee.adapter).trim() !== 'ember') {
                errors.push('[zigbee] adapter must be "ember" (Sonoff EFR32MG21 path). Remove legacy adapter values.');
            }
            config.zigbee.adapter = 'ember';
            if (!config.zigbee.db_path) {
                config.zigbee.db_path = path.join(path.dirname(absPath), 'zigbee.db');
            }
        } catch (e) {
            errors.push(e.message);
        }
    }

    // --- [node:<label>] sections ---
    const seenTopics = new Map(); // base_topic -> label
    const seenNodeIds = new Map(); // `${radio}:${node_id}` -> label

    for (const [sectionKey, sectionVal] of Object.entries(raw)) {
        if (!sectionKey.startsWith('node:')) continue;
        const label = sectionKey.slice(5).trim();

        if (!VALID_NODE_LABEL.test(label)) {
            errors.push(`[${sectionKey}] invalid label format — must match [a-z0-9][a-z0-9-]*`);
            continue;
        }

        let node;
        try {
            node = applySchema(SCHEMA.node, sectionVal, sectionKey);
        } catch (e) {
            errors.push(e.message);
            continue;
        }

        node.label = node.label || label;

        // Validate radio value
        if (!VALID_RADIOS.has(node.radio)) {
            errors.push(`[${sectionKey}] unknown radio "${node.radio}" — expected: ${[...VALID_RADIOS].join(', ')}`);
        }

        // Validate type
        if (!VALID_TYPES.has(node.type)) {
            errors.push(`[${sectionKey}] unknown type "${node.type}" — expected: ${[...VALID_TYPES].join(', ')}`);
        }

        // Z-Wave nodes need node_id
        if (node.radio === 'zwave' && !node.node_id) {
            errors.push(`[${sectionKey}] radio=zwave requires "node_id"`);
        }

        // Zigbee nodes need ieee
        if (node.radio === 'zigbee' && !node.ieee) {
            errors.push(`[${sectionKey}] radio=zigbee requires "ieee"`);
        }

        // Unique base_topic
        if (seenTopics.has(node.base_topic)) {
            errors.push(`[${sectionKey}] base_topic "${node.base_topic}" already used by node "${seenTopics.get(node.base_topic)}"`);
        } else {
            seenTopics.set(node.base_topic, label);
        }

        // Unique node_id per radio
        if (node.node_id) {
            const nik = `${node.radio}:${node.node_id}`;
            if (seenNodeIds.has(nik)) {
                errors.push(`[${sectionKey}] node_id ${node.node_id} already used by node "${seenNodeIds.get(nik)}" on radio ${node.radio}`);
            } else {
                seenNodeIds.set(nik, label);
            }
        }

        // Validate that the referenced radio is configured
        if (node.radio === 'zwave' && !raw.zwave) {
            errors.push(`[${sectionKey}] radio=zwave but no [zwave] section present`);
        }
        if (node.radio === 'zigbee' && !raw.zigbee) {
            errors.push(`[${sectionKey}] radio=zigbee but no [zigbee] section present`);
        }

        config.nodes[label] = node;
    }

    // At least one radio must be present
    if (!raw.zwave && !raw.zigbee) {
        errors.push('At least one radio section ([zwave] or [zigbee]) must be present');
    }

    if (errors.length) {
        throw new Error(`PxB config validation failed:\n  ${errors.join('\n  ')}`);
    }

    return config;
}

module.exports = { loadConfig };
