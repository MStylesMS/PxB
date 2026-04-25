'use strict';

const { loadConfig } = require('../../src/config/ini-loader');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Helper: write a temp ini file and return its path
function writeTempIni(content) {
  const f = path.join(os.tmpdir(), `pzb-test-${Date.now()}.ini`);
  fs.writeFileSync(f, content, 'utf8');
  return f;
}

afterEach(() => {
  // temp files are cleaned by OS eventually; no explicit cleanup needed
});

describe('ini-loader: minimal valid config (no nodes)', () => {
  test('loads successfully and applies defaults', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test-client
base_topic = paradox/test

[zwave]
port = /dev/ttyUSB0
`);
    const cfg = loadConfig(f);
    expect(cfg.mqtt.broker).toBe('localhost');
    expect(cfg.mqtt.port).toBe(1883);
    expect(cfg.mqtt.client_id).toBe('test-client');
    expect(cfg.mqtt.base_topic).toBe('paradox/test');
    expect(cfg.global.heartbeat_interval).toBe(10);
    expect(cfg.global.log_level).toBe('info');
    expect(cfg.global.discovered_base_topic).toBe('paradox/test/pzb/discovered');
    expect(cfg.zwave.port).toBe('/dev/ttyUSB0');
    expect(cfg.zwave.include_timeout_s).toBe(60);
    expect(cfg.nodes).toEqual({});
  });
});

describe('ini-loader: node parsing', () => {
  test('parses a contact sensor node correctly', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test

[zwave]
port = /dev/ttyUSB0

[node:spell-box]
radio = zwave
node_id = 3
type = contact
base_topic = paradox/test/zwave/spell-box
label = Spell Box
`);
    const cfg = loadConfig(f);
    const node = cfg.nodes['spell-box'];
    expect(node).toBeDefined();
    expect(node.radio).toBe('zwave');
    expect(node.node_id).toBe(3);
    expect(node.type).toBe('contact');
    expect(node.base_topic).toBe('paradox/test/zwave/spell-box');
    expect(node.label).toBe('Spell Box');
    expect(node.input_channel).toBe('0');
  });
});

describe('ini-loader: zigbee adapter enforcement', () => {
  test('accepts ember adapter and normalizes config.zigbee.adapter', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test

[zigbee]
port = /dev/ttyUSB1
adapter = ember
`);

    const cfg = loadConfig(f);
    expect(cfg.zigbee).toBeDefined();
    expect(cfg.zigbee.adapter).toBe('ember');
  });

  test('defaults adapter to ember when omitted', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test

[zigbee]
port = /dev/ttyUSB1
`);

    const cfg = loadConfig(f);
    expect(cfg.zigbee).toBeDefined();
    expect(cfg.zigbee.adapter).toBe('ember');
  });

  test('rejects legacy non-ember adapter values', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test

[zigbee]
port = /dev/ttyUSB1
adapter = zstack
`);

    expect(() => loadConfig(f)).toThrow('adapter must be "ember"');
  });
});

describe('ini-loader: validation errors', () => {
  test('missing [mqtt] section', () => {
    const f = writeTempIni(`
[zwave]
port = /dev/ttyUSB0
`);
    expect(() => loadConfig(f)).toThrow('[mqtt] section is required');
  });

  test('missing required mqtt.broker', () => {
    const f = writeTempIni(`
[mqtt]
client_id = test
base_topic = paradox/test

[zwave]
port = /dev/ttyUSB0
`);
    expect(() => loadConfig(f)).toThrow(/"broker"/);
  });

  test('missing required mqtt.client_id', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
base_topic = paradox/test

[zwave]
port = /dev/ttyUSB0
`);
    expect(() => loadConfig(f)).toThrow(/"client_id"/);
  });

  test('no radio section present', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test
`);
    expect(() => loadConfig(f)).toThrow('At least one radio section');
  });

  test('duplicate base_topic across nodes', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test

[zwave]
port = /dev/ttyUSB0

[node:box-a]
radio = zwave
node_id = 3
type = contact
base_topic = paradox/test/shared

[node:box-b]
radio = zwave
node_id = 4
type = contact
base_topic = paradox/test/shared
`);
    expect(() => loadConfig(f)).toThrow('already used by node');
  });

  test('duplicate node_id on same radio', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test

[zwave]
port = /dev/ttyUSB0

[node:box-a]
radio = zwave
node_id = 3
type = contact
base_topic = paradox/test/a

[node:box-b]
radio = zwave
node_id = 3
type = contact
base_topic = paradox/test/b
`);
    expect(() => loadConfig(f)).toThrow('node_id 3 already used');
  });

  test('invalid node label format', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test

[zwave]
port = /dev/ttyUSB0

[node:Bad Label!]
radio = zwave
node_id = 3
type = contact
base_topic = paradox/test/x
`);
    expect(() => loadConfig(f)).toThrow('invalid label format');
  });

  test('zwave node without node_id', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test

[zwave]
port = /dev/ttyUSB0

[node:missing-id]
radio = zwave
type = contact
base_topic = paradox/test/x
`);
    expect(() => loadConfig(f)).toThrow('requires "node_id"');
  });

  test('config file not found', () => {
    expect(() => loadConfig('/no/such/file.ini')).toThrow('Config file not found');
  });
});
