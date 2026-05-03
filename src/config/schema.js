'use strict';

/**
 * Per-section schema.
 * Each entry: { required: bool, type: 'string'|'int'|'bool'|'path', default?: value }
 */
const SCHEMA = {
    mqtt: {
        broker: { required: true, type: 'string' },
        port: { required: false, type: 'int', default: 1883 },
        username: { required: false, type: 'string' },
        password: { required: false, type: 'string' },
        client_id: { required: true, type: 'string' },
        base_topic: { required: true, type: 'string' },
        keepalive: { required: false, type: 'int', default: 60 },
        mqtt_qos: { required: false, type: 'int', default: 0 },
    },
    global: {
        log_level: { required: false, type: 'string', default: 'info' },
        log_directory: { required: false, type: 'path' },
        heartbeat_interval: { required: false, type: 'int', default: 10 },
        discovered_base_topic: { required: false, type: 'string' },
        discovered_ini_path: { required: false, type: 'path' },
        default_discovered_label_prefix: { required: false, type: 'string', default: 'discovered-' },
    },
    zwave: {
        enabled: { required: false, type: 'bool', default: true },
        port: { required: true, type: 'path' },
        network_key_s0: { required: false, type: 'string' },
        network_key_s2_unauth: { required: false, type: 'string' },
        network_key_s2_auth: { required: false, type: 'string' },
        network_key_s2_access: { required: false, type: 'string' },
        cache_dir: { required: false, type: 'path' },
        include_timeout_s: { required: false, type: 'int', default: 60 },
    },
    zigbee: {
        enabled: { required: false, type: 'bool', default: true },
        port: { required: true, type: 'path' },
        baud_rate: { required: false, type: 'int', default: 115200 },
        db_path: { required: false, type: 'path' },
        pan_id: { required: false, type: 'string' },
        extended_pan_id: { required: false, type: 'string' },
        channel: { required: false, type: 'int', default: 11 },
        network_key: { required: false, type: 'string' },
        include_timeout_s: { required: false, type: 'int', default: 60 },
    },
    node: {
        radio: { required: true, type: 'string' },
        node_id: { required: false, type: 'int' },
        ieee: { required: false, type: 'string' },
        type: { required: true, type: 'string' },
        base_topic: { required: true, type: 'string' },
        label: { required: false, type: 'string' },
        description: { required: false, type: 'string' },
        input_channel: { required: false, type: 'string', default: '0' },
        low_battery_threshold: { required: false, type: 'int', default: 20 },
    },
    light: {
        // Light device sections follow pattern [light:device_name]
        backend: { required: true, type: 'string' },
        topic: { required: true, type: 'string' },
        device_id: { required: false, type: 'string' },
        api_key: { required: false, type: 'string' },
        host: { required: false, type: 'string' },
        port: { required: false, type: 'int' },
        brightness: { required: false, type: 'int', default: 100 },
        hue_profile: { required: false, type: 'string' },
        scene_map: { required: false, type: 'string' },
        timeout_s: { required: false, type: 'int', default: 10 },
    },
    'light-zone': {
        // Light group sections follow pattern [light-zone:group_name]
        topic: { required: true, type: 'string' },
        devices: { required: true, type: 'string' },
    },
    switch: {
        // Switch device sections follow pattern [switch:device_name]
        backend: { required: true, type: 'string' },
        topic: { required: true, type: 'string' },
        device_id: { required: false, type: 'string' },
        host: { required: false, type: 'string' },
        port: { required: false, type: 'int' },
        timeout_s: { required: false, type: 'int', default: 10 },
    },
    'inputs:*': {
        // Inputs zones follow pattern [inputs:zone_name]
        // Aggregates sensor inputs (contact, motion, etc.)
        topic: { required: true, type: 'string' },
        filter_duplicates_ms: { required: false, type: 'int', default: 100 },
    },
    'outputs:*': {
        // Outputs zones follow pattern [outputs:zone_name]
        // Generic output aggregator for relays, GPIO, etc.
        topic: { required: true, type: 'string' },
    },
};

const VALID_NODE_LABEL = /^[a-z0-9][a-z0-9-]*$/;
const VALID_RADIOS = new Set(['zwave', 'zigbee']);
const VALID_TYPES = new Set(['contact', 'relay', 'switch', 'motion', 'custom']);
const VALID_LIGHT_BACKENDS = new Set(['hue', 'lifx', 'wiz']);
const VALID_SWITCH_BACKENDS = new Set(['shelly']);
const VALID_ZONE_TYPES = new Set(['lights', 'switches', 'inputs', 'outputs']);

module.exports = { SCHEMA, VALID_NODE_LABEL, VALID_RADIOS, VALID_TYPES, VALID_LIGHT_BACKENDS, VALID_SWITCH_BACKENDS, VALID_ZONE_TYPES };
