'use strict';

const { NodeRegistry } = require('../../src/bridge/node-registry');

const BASE_NODES = {
    'spell-box': {
        radio: 'zwave', type: 'contact', node_id: 3,
        base_topic: 'paradox/houdini/zwave/spell-box',
        input_channel: '0', description: 'Spell box sensor',
    },
    'relay-1': {
        radio: 'zwave', type: 'relay', node_id: 5,
        base_topic: 'paradox/houdini/zwave/relay-1',
        input_channel: '0', description: '',
    },
};

function makeRegistry(nodes = BASE_NODES) {
    return new NodeRegistry(nodes);
}

describe('NodeRegistry: construction', () => {
    test('builds entries from config', () => {
        const reg = makeRegistry();
        const all = reg.getAll();
        expect(all).toHaveLength(2);
        const sb = reg.getByLabel('spell-box');
        expect(sb).not.toBeNull();
        expect(sb.radio).toBe('zwave');
        expect(sb.node_id).toBe(3);
        expect(sb.status).toBe('offline');
        expect(sb.last_event).toBeNull();
        expect(sb.signals).toEqual({});
    });

    test('empty config produces empty registry', () => {
        const reg = makeRegistry({});
        expect(reg.getAll()).toHaveLength(0);
    });
});

describe('NodeRegistry: getByZWaveId', () => {
    test('finds node by integer node_id', () => {
        const reg = makeRegistry();
        expect(reg.getByZWaveId(3).label).toBe('spell-box');
        expect(reg.getByZWaveId(5).label).toBe('relay-1');
    });
    test('coerces string to number', () => {
        const reg = makeRegistry();
        expect(reg.getByZWaveId('3').label).toBe('spell-box');
    });
    test('returns null for unknown node_id', () => {
        const reg = makeRegistry();
        expect(reg.getByZWaveId(99)).toBeNull();
    });
});

describe('NodeRegistry: getByIeee', () => {
    test('finds zigbee node by normalized IEEE address', () => {
        const reg = new NodeRegistry({
            'zb-door': {
                radio: 'zigbee', type: 'contact',
                ieee: '0x00124B0012345678',
                base_topic: 'paradox/houdini/zigbee/zb-door',
                input_channel: '0', description: '',
            },
        });
        expect(reg.getByIeee('0x00124b0012345678').label).toBe('zb-door');
        // Case-insensitive
        expect(reg.getByIeee('0x00124B0012345678').label).toBe('zb-door');
        // Without 0x prefix
        expect(reg.getByIeee('00124b0012345678').label).toBe('zb-door');
    });
    test('returns null for unknown IEEE', () => {
        const reg = makeRegistry();
        expect(reg.getByIeee('0x0000000000000000')).toBeNull();
    });
    test('returns null for falsy input', () => {
        const reg = makeRegistry();
        expect(reg.getByIeee(null)).toBeNull();
        expect(reg.getByIeee('')).toBeNull();
    });
});

describe('NodeRegistry: setStatus', () => {
    test('returns true when status changes', () => {
        const reg = makeRegistry();
        expect(reg.setStatus('spell-box', 'ready')).toBe(true);
        expect(reg.getByLabel('spell-box').status).toBe('ready');
    });
    test('returns false when status is unchanged', () => {
        const reg = makeRegistry();
        reg.setStatus('spell-box', 'ready');
        expect(reg.setStatus('spell-box', 'ready')).toBe(false);
    });
    test('returns false for unknown label', () => {
        const reg = makeRegistry();
        expect(reg.setStatus('nonexistent', 'ready')).toBe(false);
    });
});

describe('NodeRegistry: updateSignal', () => {
    test('first update always reports changed', () => {
        const reg = makeRegistry();
        const { changed, entry } = reg.updateSignal('spell-box', 'contact', 'open');
        expect(changed).toBe(true);
        expect(entry.signals.contact.value).toBe('open');
        expect(typeof entry.signals.contact.ts).toBe('string');
    });
    test('same value twice → second not changed', () => {
        const reg = makeRegistry();
        reg.updateSignal('spell-box', 'contact', 'open');
        const { changed } = reg.updateSignal('spell-box', 'contact', 'open');
        expect(changed).toBe(false);
    });
    test('different value → changed', () => {
        const reg = makeRegistry();
        reg.updateSignal('spell-box', 'contact', 'open');
        const { changed } = reg.updateSignal('spell-box', 'contact', 'close');
        expect(changed).toBe(true);
    });
    test('unknown label → changed:false, entry:null', () => {
        const reg = makeRegistry();
        const result = reg.updateSignal('ghost', 'contact', 'open');
        expect(result).toEqual({ changed: false, entry: null });
    });
});

describe('NodeRegistry: setLastEvent', () => {
    test('stores event on entry', () => {
        const reg = makeRegistry();
        const ev = { input: '0', event: 'open', ts: 1234 };
        reg.setLastEvent('spell-box', ev);
        expect(reg.getByLabel('spell-box').last_event).toEqual(ev);
    });
    test('silently ignores unknown label', () => {
        const reg = makeRegistry();
        expect(() => reg.setLastEvent('ghost', {})).not.toThrow();
    });
});

describe('NodeRegistry: getSummary', () => {
    test('all offline by default', () => {
        const reg = makeRegistry();
        expect(reg.getSummary()).toEqual({ total: 2, ready: 0, failed: 0, interviewing: 0 });
    });
    test('reflects status changes', () => {
        const reg = makeRegistry();
        reg.setStatus('spell-box', 'ready');
        reg.setStatus('relay-1', 'failed');
        expect(reg.getSummary()).toEqual({ total: 2, ready: 1, failed: 1, interviewing: 0 });
    });
});
