'use strict';

const {
    loadProfile,
    listProfiles,
    parseCustomChannels,
    inferCapabilities,
} = require('../../../src/dmx/profiles');

const { validateProfile, VALID_SLOTS, VALID_CAPABILITIES } = require('../../../src/dmx/profiles/schema');

// ── validateProfile ───────────────────────────────────────────────────────

describe('validateProfile', () => {
    test('accepts a minimal valid profile', () => {
        const p = validateProfile({ name: 'test', channels: ['dimmer'], capabilities: ['dimmer'] });
        expect(p.name).toBe('test');
        expect(p.channels).toEqual(['dimmer']);
        expect(p.capabilities).toEqual(['dimmer']);
    });

    test('rejects a non-object', () => {
        expect(() => validateProfile(null)).toThrow('must be a plain object');
        expect(() => validateProfile('rgb')).toThrow('must be a plain object');
    });

    test('rejects missing name', () => {
        expect(() => validateProfile({ channels: ['dimmer'], capabilities: ['dimmer'] }))
            .toThrow(/name/);
    });

    test('rejects missing channels', () => {
        expect(() => validateProfile({ name: 'x', capabilities: ['dimmer'] }))
            .toThrow(/channels/);
    });

    test('rejects empty channels array', () => {
        expect(() => validateProfile({ name: 'x', channels: [], capabilities: ['dimmer'] }))
            .toThrow(/channels.*non-empty|non-empty.*channels/);
    });

    test('rejects unknown slot in channels', () => {
        expect(() => validateProfile({ name: 'x', channels: ['ultraviolet'], capabilities: [] }))
            .toThrow(/[Uu]nknown slot.*ultraviolet|ultraviolet/);
    });

    test('rejects unknown capability', () => {
        expect(() => validateProfile({ name: 'x', channels: ['dimmer'], capabilities: ['fly'] }))
            .toThrow(/[Uu]nknown capability.*fly|fly/);
    });

    test('rejects defaults with out-of-range value', () => {
        expect(() => validateProfile({
            name: 'x', channels: ['dimmer', 'mode'], capabilities: ['dimmer', 'mode'],
            defaults: { mode: 300 },
        })).toThrow(/defaults.*mode|mode.*must be/);
    });

    test('rejects defaults referencing an invalid slot name', () => {
        expect(() => validateProfile({
            name: 'x', channels: ['dimmer'], capabilities: ['dimmer'],
            defaults: { ultraviolet: 0 },
        })).toThrow(/defaults.*ultraviolet|ultraviolet/);
    });

    test('accepts a profile with valid defaults', () => {
        const p = validateProfile({
            name: 'par', channels: ['dimmer', 'red', 'green', 'blue', 'strobe', 'mode', 'speed'],
            capabilities: ['dimmer', 'color', 'strobe', 'mode'],
            defaults: { mode: 0, speed: 0, strobe: 0 },
        });
        expect(p.defaults).toEqual({ mode: 0, speed: 0, strobe: 0 });
    });

    test('VALID_SLOTS includes expected slots', () => {
        for (const s of ['dimmer', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'strobe', 'mode', 'speed', 'pan', 'tilt', 'gobo']) {
            expect(VALID_SLOTS.has(s)).toBe(true);
        }
    });

    test('VALID_CAPABILITIES includes expected capabilities', () => {
        for (const c of ['dimmer', 'color', 'colorTemp', 'strobe', 'pan', 'tilt', 'gobo', 'mode']) {
            expect(VALID_CAPABILITIES.has(c)).toBe(true);
        }
    });
});

// ── Built-in profiles ─────────────────────────────────────────────────────

describe('built-in profiles', () => {
    test('dimmer: 1 channel, dimmer capability', () => {
        const p = loadProfile('dimmer');
        expect(p.channels).toEqual(['dimmer']);
        expect(p.capabilities).toContain('dimmer');
        expect(p.capabilities).not.toContain('color');
    });

    test('rgb: 3 channels, color capability', () => {
        const p = loadProfile('rgb');
        expect(p.channels).toEqual(['red', 'green', 'blue']);
        expect(p.capabilities).toContain('dimmer');
        expect(p.capabilities).toContain('color');
    });

    test('rgbw: 4 channels, colorTemp capability', () => {
        const p = loadProfile('rgbw');
        expect(p.channels).toEqual(['red', 'green', 'blue', 'white']);
        expect(p.capabilities).toContain('colorTemp');
    });

    test('rgba: 4 channels, amber slot, no white', () => {
        const p = loadProfile('rgba');
        expect(p.channels).toEqual(['red', 'green', 'blue', 'amber']);
        expect(p.channels).not.toContain('white');
        expect(p.capabilities).toContain('color');
    });

    test('rgbaw: 5 channels, amber + white', () => {
        const p = loadProfile('rgbaw');
        expect(p.channels).toEqual(['red', 'green', 'blue', 'amber', 'white']);
        expect(p.capabilities).toContain('colorTemp');
    });

    test('rgbawuv: 6 channels, uv slot present', () => {
        const p = loadProfile('rgbawuv');
        expect(p.channels).toHaveLength(6);
        expect(p.channels).toContain('uv');
    });

    test('par-7ch: 7 channels, has dimmer + strobe + mode defaults', () => {
        const p = loadProfile('par-7ch');
        expect(p.channels).toHaveLength(7);
        expect(p.channels[0]).toBe('dimmer');
        expect(p.capabilities).toContain('strobe');
        expect(p.capabilities).toContain('mode');
        expect(p.defaults).toBeDefined();
        expect(p.defaults.mode).toBe(0);
        expect(p.defaults.strobe).toBe(0);
        expect(p.defaults.speed).toBe(0);
    });

    test('mover-basic: pan + tilt + dimmer', () => {
        const p = loadProfile('mover-basic');
        expect(p.channels).toContain('pan');
        expect(p.channels).toContain('tilt');
        expect(p.capabilities).toContain('pan');
        expect(p.capabilities).toContain('tilt');
    });

    test('profile names are case-insensitive', () => {
        const a = loadProfile('RGB');
        const b = loadProfile('rgb');
        expect(a.name).toBe(b.name);
    });

    test('unknown name throws descriptively', () => {
        expect(() => loadProfile('laser-show')).toThrow(/[Uu]nknown fixture/);
        expect(() => loadProfile('laser-show')).toThrow('laser-show');
        expect(() => loadProfile('laser-show')).toThrow('dimmer');
    });

    test('listProfiles returns all 8 built-ins', () => {
        const profiles = listProfiles();
        const names = Object.keys(profiles);
        expect(names).toHaveLength(14);
        for (const n of ['dimmer', 'rgb', 'rgbw', 'rgba', 'rgbaw', 'rgbawuv', 'par-7ch', 'mover-basic',
            'fogger-1ch', 'fogger-2ch', 'strobe-2ch', 'hazer-2ch', 'mover-8ch', 'mover-12ch']) {
            expect(names).toContain(n);
        }
    });
});

// ── parseCustomChannels ───────────────────────────────────────────────────

describe('parseCustomChannels', () => {
    test('parses a valid mapping', () => {
        const slots = parseCustomChannels('dimmer:1,red:2,green:3,blue:4');
        expect(slots).toEqual(['dimmer', 'red', 'green', 'blue']);
    });

    test('parses out-of-order offsets correctly', () => {
        const slots = parseCustomChannels('blue:3,green:2,red:1');
        expect(slots).toEqual(['red', 'green', 'blue']);
    });

    test('handles whitespace around entries', () => {
        const slots = parseCustomChannels(' dimmer:1 , red:2 ');
        expect(slots).toEqual(['dimmer', 'red']);
    });

    test('rejects missing channels key', () => {
        expect(() => parseCustomChannels('')).toThrow('non-empty');
        expect(() => parseCustomChannels(undefined)).toThrow('non-empty');
    });

    test('rejects malformed entry', () => {
        expect(() => parseCustomChannels('red-2')).toThrow(/Invalid channels entry/);
    });

    test('rejects unknown slot name', () => {
        expect(() => parseCustomChannels('laser:1')).toThrow('Unknown slot "laser"');
    });

    test('rejects duplicate offset', () => {
        expect(() => parseCustomChannels('red:1,green:1')).toThrow(/[Dd]uplicate offset/);
    });

    test('rejects gap in offsets', () => {
        expect(() => parseCustomChannels('dimmer:1,red:3')).toThrow(/[Gg]ap/);
    });
});

// ── inferCapabilities ─────────────────────────────────────────────────────

describe('inferCapabilities', () => {
    test('dimmer slot → dimmer capability', () => {
        expect(inferCapabilities(['dimmer'])).toContain('dimmer');
    });

    test('rgb slots → color capability', () => {
        const caps = inferCapabilities(['red', 'green', 'blue']);
        expect(caps).toContain('color');
    });

    test('white slot → colorTemp capability', () => {
        const caps = inferCapabilities(['red', 'green', 'blue', 'white']);
        expect(caps).toContain('colorTemp');
    });

    test('strobe slot → strobe capability', () => {
        expect(inferCapabilities(['strobe'])).toContain('strobe');
    });

    test('no duplicates in result', () => {
        const caps = inferCapabilities(['red', 'green', 'blue', 'amber', 'white']);
        const colorCount = caps.filter(c => c === 'color').length;
        expect(colorCount).toBe(1);
    });
});

// ── loadProfile('custom') ─────────────────────────────────────────────────

describe("loadProfile('custom')", () => {
    test('builds a valid profile from channels string', () => {
        const p = loadProfile('custom', { channels: 'dimmer:1,red:2,green:3,blue:4,white:5' });
        expect(p.channels).toEqual(['dimmer', 'red', 'green', 'blue', 'white']);
        expect(p.capabilities).toContain('color');
        expect(p.capabilities).toContain('colorTemp');
        expect(p.capabilities).toContain('dimmer');
    });

    test('infers capabilities from solo dimmer channel', () => {
        const p = loadProfile('custom', { channels: 'dimmer:1' });
        expect(p.capabilities).toEqual(['dimmer']);
    });

    test('uses custom name from opts.name', () => {
        const p = loadProfile('custom', { channels: 'dimmer:1', name: 'my-par' });
        expect(p.name).toBe('my-par');
    });

    test('throws if channels key is missing', () => {
        expect(() => loadProfile('custom', {})).toThrow(/non-empty/);
    });

    test('throws on gap in offset sequence', () => {
        expect(() => loadProfile('custom', { channels: 'dimmer:1,red:3' })).toThrow(/[Gg]ap/);
    });

    test('throws for unknown slot in custom channels', () => {
        expect(() => loadProfile('custom', { channels: 'laser:1' })).toThrow('laser');
    });
});
