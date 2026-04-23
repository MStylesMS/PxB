'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../util/logger');
const { buildIniFragment, describeNode } = require('./ini-generator');

/**
 * DiscoveredStore — persists INI fragments for operator-inclusion events.
 *
 * Responsibilities:
 *   - Keep an in-memory map of `{ nodeId → { descriptor, fragment } }`.
 *   - Persist a sidecar INI file so operators can `pzb dump-ini` later.
 *   - The store is idempotent: re-discovering the same node updates its entry.
 *
 * File format: fragments are appended with a marker header, separated by blank
 * lines. Rewrites the full file on each change (file is small — one block per
 * discovered node).
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
        this._entries = new Map(); // nodeId → { descriptor, fragment }
        this._loaded = false;
    }

    /** Record a discovered node (or refresh an existing one). */
    record(node) {
        const descriptor = describeNode(node);
        const fragment = buildIniFragment(node, { labelPrefix: this._labelPrefix });
        this._entries.set(Number(node.id), { descriptor, fragment });
        this._flush();
        return { descriptor, fragment };
    }

    /** Remove a discovered entry (on exclusion). */
    forget(nodeId) {
        const changed = this._entries.delete(Number(nodeId));
        if (changed) this._flush();
        return changed;
    }

    get(nodeId) {
        return this._entries.get(Number(nodeId)) || null;
    }

    all() {
        return Array.from(this._entries.values());
    }

    _flush() {
        if (!this._filePath) return;
        try {
            fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
            const header = `; PZB discovered-node fragments — auto-generated, safe to edit\n; Generated: ${new Date().toISOString()}\n\n`;
            const body = this.all().map((e) => e.fragment).join('\n');
            fs.writeFileSync(this._filePath, header + body, 'utf8');
        } catch (err) {
            logger.warn(`DiscoveredStore: failed to write ${this._filePath}: ${err.message}`);
        }
    }
}

module.exports = { DiscoveredStore };
