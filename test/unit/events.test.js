'use strict';

const EventEmitter = require('events');
const { ZWaveEvents } = require('../../src/radios/zwave/events');
const { NodeRegistry } = require('../../src/bridge/node-registry');

class MockMqtt {
    constructor() { this.publishes = []; }
    publish(topic, payload, opts = {}) {
        this.publishes.push({ topic, payload, retain: !!opts.retain });
    }
    byTopic(topic) { return this.publishes.filter((p) => p.topic === topic); }
}

class MockDriver extends EventEmitter { }

function makeSetup() {
    const mqtt = new MockMqtt();
    const registry = new NodeRegistry({
        'spell-box': {
            radio: 'zwave',
            type: 'contact',
            node_id: 8,
            base_topic: 'paradox/test/zwave/spell-box',
        },
    });
    const driver = new MockDriver();
    const events = new ZWaveEvents({ zwaveDriver: driver, nodeRegistry: registry, mqttClient: mqtt });
    return { mqtt, registry, driver, events };
}

describe('ZWaveEvents — schema', () => {
    test('publishes retained schema once on construction per configured zwave node', () => {
        const { mqtt } = makeSetup();
        const pubs = mqtt.byTopic('paradox/test/zwave/spell-box/schema');
        expect(pubs).toHaveLength(1);
        expect(pubs[0].retain).toBe(true);
        const s = pubs[0].payload;
        expect(s.application).toBe('pzb');
        expect(s.label).toBe('spell-box');
        expect(s.radio).toBe('zwave');
        expect(s.type).toBe('contact');
        expect(s.node_id).toBe(8);
        expect(s.topics.events).toBe('paradox/test/zwave/spell-box/events');
        expect(s.topics.state).toBe('paradox/test/zwave/spell-box/state');
        expect(s.event_values).toEqual(['open', 'close']);
    });
});

describe('ZWaveEvents — contact value updates', () => {
    test('publishes retained short event and flat state on change', () => {
        const { mqtt, driver } = makeSetup();
        mqtt.publishes = []; // drop schema

        driver.emit('node-value-updated', {
            nodeId: 8, commandClass: 113, property: 'Access Control', newValue: 22,
        });

        const eventPubs = mqtt.byTopic('paradox/test/zwave/spell-box/events');
        expect(eventPubs).toHaveLength(1);
        expect(eventPubs[0].payload).toEqual({ event: 'open' });
        expect(eventPubs[0].retain).toBe(true);

        const statePubs = mqtt.byTopic('paradox/test/zwave/spell-box/state');
        expect(statePubs).toHaveLength(1);
        const st = statePubs[0].payload;
        expect(statePubs[0].retain).toBe(true);
        expect(st.state).toBe('open');
        expect(typeof st.ts).toBe('string');
        expect(st.source).toBe('zwave-node-8');
        expect(st.battery).toBe(null);
        expect(st.tamper).toBe(null);
    });

    test('does not republish when value has not changed', () => {
        const { mqtt, driver } = makeSetup();
        driver.emit('node-value-updated', { nodeId: 8, commandClass: 113, property: 'Access Control', newValue: 22 });
        mqtt.publishes = [];
        driver.emit('node-value-updated', { nodeId: 8, commandClass: 113, property: 'Access Control', newValue: 22 });

        expect(mqtt.byTopic('paradox/test/zwave/spell-box/events')).toHaveLength(0);
        expect(mqtt.byTopic('paradox/test/zwave/spell-box/state')).toHaveLength(0);
    });
});

describe('ZWaveEvents — battery', () => {
    test('battery CC update publishes state with battery block (no event)', () => {
        const { mqtt, driver } = makeSetup();
        mqtt.publishes = []; // drop schema

        driver.emit('node-value-updated', {
            nodeId: 8, commandClass: 128, property: 'level', newValue: 62,
        });

        expect(mqtt.byTopic('paradox/test/zwave/spell-box/events')).toHaveLength(0);
        const statePubs = mqtt.byTopic('paradox/test/zwave/spell-box/state');
        expect(statePubs).toHaveLength(1);
        const st = statePubs[0].payload;
        expect(st.battery).toEqual({ level: 62, ts: expect.any(String) });
        expect(st.state).toBe(null);
    });
});

describe('ZWaveEvents — reachable / status', () => {
    test('status change publishes state with reachable block', () => {
        const { mqtt, driver } = makeSetup();
        mqtt.publishes = [];

        driver.emit('node-status-changed', { nodeId: 8, status: 'alive' });
        const statePubs = mqtt.byTopic('paradox/test/zwave/spell-box/state');
        expect(statePubs.length).toBeGreaterThanOrEqual(1);
        const last = statePubs[statePubs.length - 1].payload;
        expect(last.reachable).toEqual({ value: true, ts: expect.any(String) });
    });
});
