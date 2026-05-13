'use strict';

const { loadConfig } = require('../../../src/config/ini-loader');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

function writeTmp(content) {
    const f = path.join(os.tmpdir(), `pxb-dmx-test-${Date.now()}-${Math.random().toString(36).slice(2)}.ini`);
    fs.writeFileSync(f, content, 'utf8');
    return f;
}

// Minimal valid radio section to satisfy the 'at least one radio' requirement
const BASE = `
[mqtt]
broker = localhost
client_id = pxb-test
base_topic = paradox/pxb

[zwave]
port = /dev/ttyUSB0
`;

function parse(dmxSection) {
    const content = BASE + dmxSection;
    const f = writeTmp(content);
    try {
        const config = loadConfig(f);
        return { config, error: null };
    } catch (err) {
        return { config: null, error: err.message };
    }
}

describe('ini-loader — [dmx] section absent', () => {
    it('config.dmx is null when no [dmx] section', () => {
        const { config } = parse('');
        expect(config.dmx).toBeNull();
    });
});

describe('ini-loader — [dmx] valid section', () => {
    const VALID = `
[dmx]
interface = opendmx
port = /dev/ttyUSB0
`;

    it('parses valid section without errors', () => {
        const { config, error } = parse(VALID);
        expect(error).toBeNull();
        expect(config.dmx).not.toBeNull();
    });

    it('sets correct interface and port', () => {
        const { config } = parse(VALID);
        expect(config.dmx.interface).toBe('opendmx');
        expect(config.dmx.port).toBe('/dev/ttyUSB0');
    });

    it('defaults refresh_hz to 30', () => {
        const { config } = parse(VALID);
        expect(config.dmx.refresh_hz).toBe(30);
    });

    it('defaults universe_size to 512', () => {
        const { config } = parse(VALID);
        expect(config.dmx.universe_size).toBe(512);
    });

    it('accepts custom refresh_hz and universe_size', () => {
        const { config, error } = parse(VALID + 'refresh_hz = 25\nuniverse_size = 48\n');
        expect(error).toBeNull();
        expect(config.dmx.refresh_hz).toBe(25);
        expect(config.dmx.universe_size).toBe(48);
    });
});

describe('ini-loader — [dmx] enttec-pro accepted (Phase 4 implemented)', () => {
    it('parses enttec-pro interface without error', () => {
        const { config, error } = parse(`
[dmx]
interface = enttec-pro
port = /dev/ttyUSB0
`);
        expect(error).toBeNull();
        expect(config.dmx.interface).toBe('enttec-pro');
    });
});

describe('ini-loader — [dmx] unknown interface rejected', () => {
    it('produces an error for unknown interface name', () => {
        const { error } = parse(`
[dmx]
interface = banana
port = /dev/ttyUSB0
`);
        expect(error).not.toBeNull();
        expect(/unknown interface/i.test(error)).toBe(true);
    });
});

describe('ini-loader — [dmx] range validation', () => {
    it('rejects refresh_hz below 1', () => {
        const { error } = parse(`
[dmx]
interface = opendmx
port = /dev/ttyUSB0
refresh_hz = 0
`);
        expect(error).not.toBeNull();
        expect(/refresh_hz/i.test(error)).toBe(true);
    });

    it('rejects refresh_hz above 44', () => {
        const { error } = parse(`
[dmx]
interface = opendmx
port = /dev/ttyUSB0
refresh_hz = 45
`);
        expect(error).not.toBeNull();
        expect(/refresh_hz/i.test(error)).toBe(true);
    });

    it('rejects universe_size below 24', () => {
        const { error } = parse(`
[dmx]
interface = opendmx
port = /dev/ttyUSB0
universe_size = 23
`);
        expect(error).not.toBeNull();
        expect(/universe_size/i.test(error)).toBe(true);
    });

    it('rejects universe_size above 512', () => {
        const { error } = parse(`
[dmx]
interface = opendmx
port = /dev/ttyUSB0
universe_size = 513
`);
        expect(error).not.toBeNull();
        expect(/universe_size/i.test(error)).toBe(true);
    });
});

describe('ini-loader — [dmx] missing required keys', () => {
    it('rejects section with no port', () => {
        const { error } = parse(`
[dmx]
interface = opendmx
`);
        expect(error).not.toBeNull();
    });

    it('rejects section with no interface', () => {
        const { error } = parse(`
[dmx]
port = /dev/ttyUSB0
`);
        expect(error).not.toBeNull();
    });
});
