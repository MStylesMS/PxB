'use strict';

const { buildIniFragment, describeNode, guessType } = require('../../src/discovery/ini-generator');
const { DiscoveredStore } = require('../../src/discovery/discovered-store');
const fs = require('fs');
const path = require('path');
const os = require('os');

function mockNode({ id = 3, ccs = [] } = {}) {
    const supports = new Set(ccs);
    const commandClasses = {};
    if (supports.has(37)) commandClasses['Binary Switch'] = {};
    if (supports.has(113)) commandClasses['Notification'] = {};
    if (supports.has(38)) commandClasses['Multilevel Switch'] = {};
    return {
        id,
        manufacturerId: 0x0086,
        productType: 0x0102,
        productId: 0x0064,
        label: 'Test Sensor',
        deviceClass: {
            generic: { label: 'Binary Sensor' },
            specific: { label: 'Door/Window Sensor' },
        },
        commandClasses,
        supportsCC: (cc) => supports.has(cc),
    };
}

describe('guessType', () => {
    test('relay for Binary Switch CC', () => {
        expect(guessType(mockNode({ ccs: [37] }))).toBe('relay');
    });
    test('contact for Notification CC', () => {
        expect(guessType(mockNode({ ccs: [113] }))).toBe('contact');
    });
    test('switch for Multilevel Switch CC', () => {
        expect(guessType(mockNode({ ccs: [38] }))).toBe('switch');
    });
    test('custom when nothing matches', () => {
        expect(guessType(mockNode({ ccs: [] }))).toBe('custom');
    });
});

describe('describeNode', () => {
    test('captures identity fields', () => {
        const d = describeNode(mockNode({ id: 5, ccs: [113] }));
        expect(d.node_id).toBe(5);
        expect(d.manufacturer_id).toBe(0x0086);
        expect(d.guessed_type).toBe('contact');
    });
});

describe('buildIniFragment', () => {
    test('generates a valid-looking fragment with node_id and TODOs', () => {
        const frag = buildIniFragment(mockNode({ id: 4, ccs: [113] }));
        expect(frag).toMatch(/\[node:discovered-4\]/);
        expect(frag).toMatch(/node_id\s*=\s*4/);
        expect(frag).toMatch(/type\s*=\s*contact/);
        expect(frag).toMatch(/TODO/);
    });

    test('honors labelPrefix', () => {
        const frag = buildIniFragment(mockNode({ id: 4 }), { labelPrefix: 'zp' });
        expect(frag).toMatch(/\[node:zp-4\]/);
    });
});

describe('DiscoveredStore', () => {
    let tmpFile;
    beforeEach(() => {
        tmpFile = path.join(os.tmpdir(), `pzb-discovered-${process.pid}-${Date.now()}.ini`);
    });
    afterEach(() => {
        try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
    });

    test('records and persists a fragment', () => {
        const store = new DiscoveredStore({ filePath: tmpFile });
        store.record(mockNode({ id: 3, ccs: [113] }));
        expect(fs.existsSync(tmpFile)).toBe(true);
        const content = fs.readFileSync(tmpFile, 'utf8');
        expect(content).toMatch(/\[node:discovered-3\]/);
    });

    test('re-recording same node replaces the fragment', () => {
        const store = new DiscoveredStore({ filePath: tmpFile });
        store.record(mockNode({ id: 3, ccs: [113] }));
        store.record(mockNode({ id: 3, ccs: [113] }));
        expect(store.all()).toHaveLength(1);
    });

    test('forget removes the fragment', () => {
        const store = new DiscoveredStore({ filePath: tmpFile });
        store.record(mockNode({ id: 3, ccs: [113] }));
        expect(store.forget(3)).toBe(true);
        expect(store.all()).toHaveLength(0);
    });

    test('memory-only mode skips file I/O', () => {
        const store = new DiscoveredStore({ filePath: null });
        store.record(mockNode({ id: 3, ccs: [113] }));
        expect(store.get(3)).not.toBeNull();
    });
});
