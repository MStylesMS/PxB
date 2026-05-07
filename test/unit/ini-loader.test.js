'use strict';

const { loadConfig } = require('../../src/config/ini-loader');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Helper: write a temp ini file and return its path
function writeTempIni(content) {
  const f = path.join(os.tmpdir(), `pxb-test-${Date.now()}.ini`);
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
    expect(cfg.global.discovered_base_topic).toBe('paradox/test/pxb/discovered');
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

  test('no radio section present is allowed when no nodes are defined', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test
`);
    const cfg = loadConfig(f);
    expect(cfg.nodes).toEqual({});
  });

  test('no radio section fails when node sections are defined', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test

[node:door]
radio = zwave
node_id = 1
type = contact
base_topic = paradox/test/door
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

  test('parses [light:*] and [light-zone:*] sections', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test

[light:wiz-201]
backend = wiz
topic = paradox/test/lights/wiz-201
host = 192.168.1.201

[light:hue-main]
backend = hue
topic = paradox/test/lights/hue-main
host = 192.168.1.5
api_key = abc123
hue_target_type = group
hue_target_id = 7

[light-zone:lights]
topic = paradox/test/lights
devices = wiz-201,hue-main
`);

    const cfg = loadConfig(f);
    expect(cfg.lights['wiz-201'].backend).toBe('wiz');
    expect(cfg.lights['hue-main'].backend).toBe('hue');
    expect(cfg.lights['hue-main'].hue_target_type).toBe('group');
    expect(cfg.lights['hue-main'].hue_target_id).toBe('7');
    expect(cfg.light_zones.lights.devices).toEqual(['wiz-201', 'hue-main']);
  });

  test('validates Hue target config shape', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test

[light:hue-main]
backend = hue
topic = paradox/test/lights/hue-main
host = 192.168.1.5
api_key = abc123
hue_target_type = light
`);

    expect(() => loadConfig(f)).toThrow('hue_target_type=light requires "hue_target_id"');
  });

  test('rejects Hue target id when target type is all', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test

[light:hue-main]
backend = hue
topic = paradox/test/lights/hue-main
host = 192.168.1.5
api_key = abc123
hue_target_type = all
hue_target_id = 7
`);

    expect(() => loadConfig(f)).toThrow('hue_target_id is only valid when hue_target_type is "group" or "light"');
  });

  test('validates light-zone devices reference existing lights', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test

[light:wiz-201]
backend = wiz
topic = paradox/test/lights/wiz-201
host = 192.168.1.201

[light-zone:lights]
topic = paradox/test/lights
devices = wiz-201,missing-light
`);

    expect(() => loadConfig(f)).toThrow('references unknown light "missing-light"');
  });

  test('parses [switch:*] sections', () => {
    const f = writeTempIni(`
[mqtt]
broker = localhost
client_id = test
base_topic = paradox/test

[switch:relay-1]
backend = shelly
topic = paradox/test/switch/relay-1
host = 192.168.1.50
`);

    const cfg = loadConfig(f);
    expect(cfg.switches['relay-1'].backend).toBe('shelly');
    expect(cfg.switches['relay-1'].host).toBe('192.168.1.50');
  });
});
