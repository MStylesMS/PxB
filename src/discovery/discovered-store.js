'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../util/logger');
const {
    buildIniFragment, describeNode,
    buildZigbeeIniFragment, describeZigbeeDevice,
} = require('./ini-generator');

/**
 * DiscoveredStore — persists INI fragments for operator-inclusion events.
 *
 * Responsibilities:
 *   - Keep an in-memory map keyed by `zwave-<nodeId>` / `zigbee-<ieee>`.
 *   - Persist a sidecar INI file so operators can `pzb dump-ini` later.
 *   - The store is idempotent: re-discovering the same device updates its entry.
 *
 * File format: fragments are appended with a marker header, separated by blank
 * lines. Rewrites the full file on each change (file is small — one block per
 * discovered device).
 */
class DiscoveredStore {
    /**
     * @param {object} opts
     * @param {string|null} opts.filePath - path to sidecar INI file (null = memory-only)
     * @param {string} [opts.labelPrefix='discovered']
     */
    constructor({ filePath, labelPrefix = 'discovered' } = {}) {
        this._filePath = filePath || null;
        this._labelPrefix = labelPrefix;
        this._entries = new Map(); // composite-key → { radio, descriptor, fragment }
        this._loaded = false;
    }

    /** Record a discovered Z-Wave node (or refresh an existing one). */
    record(node) {
        const descriptor = describeNode(node);
        const fragment = buildIniFragment(node, { labelPrefix: this._labelPrefix });
        const key = `zwave-${Number(node.id)}`;
        this._entries.set(key, { radio: 'zwave', descriptor, fragment });
        this._flush();
        return { descriptor, fragment };
    }

    /** Record a discovered Zigbee device (or refresh). */
    recordZigbee(device) {
        const descriptor = describeZigbeeDevice(device);
        const fragment = buildZigbeeIniFragment(device, { labelPrefix: this._labelPrefix });
        if (!descriptor.ieee) return { descriptor, fragment };
        const key = `zigbee-${descriptor.ieee}`;
        this._entries.set(key, { radio: 'zigbee', descriptor, fragment });
        this._flush();
        return { descriptor, fragment };
    }

    /** Remove a discovered Z-Wave entry (on exclusion). */
    forget(nodeId) {
        const changed = this._entries.delete(`zwave-${Number(nodeId)}`);
        if (changed) this._flush();
        return changed;
    }

    /** Remove a discovered Zigbee entry. */
    forgetZigbee(ieee) {
        const normalized = _normalizeIeee(ieee);
        if (!normalized) return false;
        const changed = this._entries.delete(`zigbee-${normalized}`);
        if (changed) this._flush();
        return changed;
    }

    get(nodeId) {
        return this._entries.get(`zwave-${Number(nodeId)}`) || null;
    }

    getZigbee(ieee) {
        const normalized = _normalizeIeee(ieee);
        if (!normalized) return null;
        return this._entries.get(`zigbee-${normalized}`) || null;
    }

    all() {
        return Array.from(this._entries.values());
    }

    _flush() {
        if (!this._filePath) return;
        try {
            fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
            const header = `; PZB discovered-device fragments — auto-generated, safe to edit\n; Generated: ${new Date().toISOString()}\n\n`;
            const body = this.all().map((e) => e.fragment).join('\n');
            fs.writeFileSync(this._filePath, header + body, 'utf8');
        } catch (err) {
            logger.warn(`DiscoveredStore: failed to write ${this._filePath}: ${err.message}`);
        }
    }
}

function _normalizeIeee(raw) {
    if (!raw) return null;
    const s = String(raw).trim().toLowerCase().replace(/^0x/, '').replace(/[^0-9a-f]/g, '');
    if (!s) return null;
    return `0x${s.padStart(16, '0')}`;
}

module.exports = { DiscoveredStore };
