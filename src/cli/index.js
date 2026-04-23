#!/usr/bin/env node
'use strict';

/**
 * PZB CLI — read-only status/inspection commands.
 *
 * Usage:
 *   pzb status     --config <path>  [--timeout <ms>]
 *   pzb list-nodes --config <path>
 *   pzb help
 */

const path = require('path');

// ---- Minimal arg parser -----------------------------------------------

function parseArgs(argv) {
    const args = { positional: [] };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if ((a === '--config' || a === '-c') && argv[i + 1]) {
            args.config = argv[++i];
        } else if (a === '--timeout' && argv[i + 1]) {
            args.timeout = parseInt(argv[++i], 10);
        } else if (a === '--log-level' && argv[i + 1]) {
            args.logLevel = argv[++i];
        } else if (a === '--ms' && argv[i + 1]) {
            args.ms = parseInt(argv[++i], 10);
        } else if (a === '--node-id' && argv[i + 1]) {
            args.nodeId = parseInt(argv[++i], 10);
        } else if (a === '--timeout-s' && argv[i + 1]) {
            args.timeoutS = parseInt(argv[++i], 10);
        } else if (!a.startsWith('-')) {
            args.positional.push(a);
        }
    }
    args.subcommand = args.positional[0] || 'help';
    return args;
}

// ---- Helpers ---------------------------------------------------------------

function requireConfig(args) {
    if (!args.config) {
        process.stderr.write('Error: --config <path> is required\n');
        process.exit(1);
    }
    return args.config;
}

function prettyJson(obj) {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// ---- Subcommands -----------------------------------------------------------

/**
 * `pzb status` — subscribe to pzb/status, print the first message, then exit.
 */
async function cmdStatus(args) {
    const configPath = requireConfig(args);
    const { loadConfig } = require('../config/ini-loader');
    const { MqttClient } = require('../mqtt/client');
    const { bridgeTopics } = require('../mqtt/contract');

    let config;
    try {
        config = loadConfig(configPath);
    } catch (err) {
        process.stderr.write(`Config error: ${err.message}\n`);
        process.exit(1);
    }

    const mqtt = new MqttClient({
        ...config.mqtt,
        client_id: `${config.mqtt.client_id}-cli`,
    });
    const timeoutMs = args.timeout || 5000;
    const topics = bridgeTopics(config.mqtt.base_topic);

    await mqtt.connect();

    let received = false;
    mqtt.subscribe(topics.status, (topic, payload) => {
        if (received) return;
        received = true;
        prettyJson(payload);
        mqtt.disconnect().then(() => process.exit(0));
    });

    setTimeout(() => {
        if (!received) {
            process.stderr.write(
                `Timeout: no status message received on "${topics.status}" within ${timeoutMs}ms\n` +
                'Is PZB running and connected to the same broker?\n'
            );
            mqtt.disconnect().then(() => process.exit(1));
        }
    }, timeoutMs);
}

/**
 * `pzb list-nodes` — read config and print all configured nodes.
 * Does not require a live MQTT connection.
 */
function cmdListNodes(args) {
    const configPath = requireConfig(args);
    const { loadConfig } = require('../config/ini-loader');

    let config;
    try {
        config = loadConfig(configPath);
    } catch (err) {
        process.stderr.write(`Config error: ${err.message}\n`);
        process.exit(1);
    }

    const nodes = Object.values(config.nodes);
    if (nodes.length === 0) {
        process.stdout.write('No nodes configured.\n');
        return;
    }

    // Table header
    const cols = ['label', 'radio', 'type', 'node_id/ieee', 'base_topic'];
    const rows = nodes.map((n) => [
        n.label,
        n.radio,
        n.type,
        n.node_id != null ? String(n.node_id) : (n.ieee || '—'),
        n.base_topic,
    ]);

    const widths = cols.map((c, i) =>
        Math.max(c.length, ...rows.map((r) => String(r[i]).length))
    );

    const fmt = (row) => row.map((cell, i) => String(cell).padEnd(widths[i])).join('  ');

    process.stdout.write(fmt(cols) + '\n');
    process.stdout.write(widths.map((w) => '-'.repeat(w)).join('  ') + '\n');
    for (const row of rows) {
        process.stdout.write(fmt(row) + '\n');
    }
    process.stdout.write(`\n${nodes.length} node(s) configured.\n`);
}

/**
 * `pzb help`
 */
function cmdHelp() {
    process.stdout.write(
        'Usage: pzb <subcommand> --config <path/to/pzb.ini> [options]\n\n' +
        'Subcommands:\n' +
        '  status                        Print current bridge status (reads from MQTT)\n' +
        '  list-nodes                    Print configured nodes from INI (no broker needed)\n' +
        '  include [--timeout-s N]       Begin Z-Wave inclusion\n' +
        '  stop-include                  Abort in-progress inclusion\n' +
        '  exclude [--timeout-s N]       Begin Z-Wave exclusion\n' +
        '  stop-exclude                  Abort in-progress exclusion\n' +
        '  relay <label> on|off|pulse    Send relay command to a configured node\n' +
        '                                (with --ms N for pulse duration)\n' +
        '  refresh-node <label|node_id>  Re-interview a node\n' +
        '  remove-failed-node <node_id>  Remove a dead Z-Wave node from the controller\n' +
        '  dump-ini --node-id N          Print the discovered INI fragment for a node\n' +
        '  help                          Show this help\n\n' +
        'Options:\n' +
        '  --config, -c <path>           Path to pzb.ini  (required)\n' +
        '  --timeout <ms>                Timeout for status/discovery commands (default: 5000)\n' +
        '  --ms <N>                      Pulse duration in ms (for `relay <label> pulse`)\n' +
        '  --timeout-s <N>               Inclusion/exclusion timeout seconds\n'
    );
}

// ---- Phase 2 MQTT-based control commands ----------------------------------

function _openMqtt(config) {
    const { MqttClient } = require('../mqtt/client');
    const mqtt = new MqttClient({
        ...config.mqtt,
        client_id: `${config.mqtt.client_id}-cli`,
    });
    return mqtt;
}

function _loadConfigOrExit(configPath) {
    const { loadConfig } = require('../config/ini-loader');
    try {
        return loadConfig(configPath);
    } catch (err) {
        process.stderr.write(`Config error: ${err.message}\n`);
        process.exit(1);
    }
}

async function _publishBridgeCommand(config, command, extra = {}) {
    const { bridgeTopics } = require('../mqtt/contract');
    const mqtt = _openMqtt(config);
    await mqtt.connect();
    mqtt.publish(bridgeTopics(config.mqtt.base_topic).commands, { command, ...extra }, { retain: false });
    // Small delay so publish flushes before disconnect.
    await new Promise((r) => setTimeout(r, 150));
    await mqtt.disconnect();
    process.stdout.write(`${command} sent.\n`);
}

async function cmdInclude(args) {
    const config = _loadConfigOrExit(requireConfig(args));
    await _publishBridgeCommand(config, 'startInclusion',
        args.timeoutS ? { timeout_s: args.timeoutS } : {});
}

async function cmdStopInclude(args) {
    const config = _loadConfigOrExit(requireConfig(args));
    await _publishBridgeCommand(config, 'stopInclusion');
}

async function cmdExclude(args) {
    const config = _loadConfigOrExit(requireConfig(args));
    await _publishBridgeCommand(config, 'startExclusion',
        args.timeoutS ? { timeout_s: args.timeoutS } : {});
}

async function cmdStopExclude(args) {
    const config = _loadConfigOrExit(requireConfig(args));
    await _publishBridgeCommand(config, 'stopExclusion');
}

async function cmdRefreshNode(args) {
    const config = _loadConfigOrExit(requireConfig(args));
    const target = args.positional[1];
    if (!target) {
        process.stderr.write('Usage: pzb refresh-node <label|node_id> --config <path>\n');
        process.exit(1);
    }
    const extra = /^\d+$/.test(target) ? { node_id: Number(target) } : { label: target };
    await _publishBridgeCommand(config, 'refreshNode', extra);
}

async function cmdRemoveFailedNode(args) {
    const config = _loadConfigOrExit(requireConfig(args));
    const target = args.positional[1];
    if (!target || !/^\d+$/.test(target)) {
        process.stderr.write('Usage: pzb remove-failed-node <node_id> --config <path>\n');
        process.exit(1);
    }
    await _publishBridgeCommand(config, 'removeFailedNode', { node_id: Number(target) });
}

async function cmdRelay(args) {
    const config = _loadConfigOrExit(requireConfig(args));
    const label = args.positional[1];
    const action = (args.positional[2] || '').toLowerCase();
    if (!label || !['on', 'off', 'pulse'].includes(action)) {
        process.stderr.write('Usage: pzb relay <label> on|off|pulse [--ms N] --config <path>\n');
        process.exit(1);
    }
    const entry = config.nodes[label];
    if (!entry) {
        process.stderr.write(`Unknown node label: ${label}\n`);
        process.exit(1);
    }
    if (entry.type !== 'relay' && entry.type !== 'switch') {
        process.stderr.write(`Node "${label}" has type=${entry.type}; relay commands require type=relay or switch.\n`);
        process.exit(1);
    }
    const { nodeTopics } = require('../mqtt/contract');
    const mqtt = _openMqtt(config);
    await mqtt.connect();
    const topic = nodeTopics(entry.base_topic).commands;
    let payload;
    if (action === 'pulse') {
        payload = { command: 'pulseRelay', ms: args.ms || 500 };
    } else {
        payload = { command: 'setRelay', state: action };
    }
    mqtt.publish(topic, payload, { retain: false });
    await new Promise((r) => setTimeout(r, 150));
    await mqtt.disconnect();
    process.stdout.write(`relay ${label} ${action}${action === 'pulse' ? ` (${payload.ms}ms)` : ''} sent to ${topic}\n`);
}

/**
 * `pzb dump-ini --node-id N` — read the DiscoveredStore sidecar file and print
 * the fragment for the requested node. No live MQTT needed.
 */
function cmdDumpIni(args) {
    const configPath = requireConfig(args);
    const config = _loadConfigOrExit(configPath);
    const fs = require('fs');
    const filePath = config.global.discovered_ini_path;
    if (!filePath) {
        process.stderr.write('Error: [global] discovered_ini_path is not configured.\n');
        process.exit(1);
    }
    if (!fs.existsSync(filePath)) {
        process.stderr.write(`Error: discovered INI file not found: ${filePath}\n` +
            '(No nodes have been discovered yet.)\n');
        process.exit(1);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    if (!args.nodeId) {
        process.stdout.write(content);
        return;
    }
    // Extract the fragment matching node_id = N.
    const lines = content.split('\n');
    const blocks = [];
    let current = [];
    for (const line of lines) {
        if (line.startsWith('; ----')) {
            if (current.length) blocks.push(current.join('\n'));
            current = [line];
        } else {
            current.push(line);
        }
    }
    if (current.length) blocks.push(current.join('\n'));
    const target = blocks.find((b) => new RegExp(`^\\s*node_id\\s*=\\s*${args.nodeId}\\b`, 'm').test(b));
    if (!target) {
        process.stderr.write(`No discovered fragment found for node_id=${args.nodeId}.\n`);
        process.exit(1);
    }
    process.stdout.write(target + '\n');
}

// ---- Entry point -----------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv);

    // If invoked as `node src/index.js --config ...` (service mode), delegate to service
    if (!args.subcommand || args.subcommand === 'help') {
        cmdHelp();
        process.exit(0);
    }

    switch (args.subcommand) {
        case 'status':
            await cmdStatus(args);
            break;
        case 'list-nodes':
            cmdListNodes(args);
            break;
        case 'include':
            await cmdInclude(args);
            break;
        case 'stop-include':
            await cmdStopInclude(args);
            break;
        case 'exclude':
            await cmdExclude(args);
            break;
        case 'stop-exclude':
            await cmdStopExclude(args);
            break;
        case 'relay':
            await cmdRelay(args);
            break;
        case 'refresh-node':
            await cmdRefreshNode(args);
            break;
        case 'remove-failed-node':
            await cmdRemoveFailedNode(args);
            break;
        case 'dump-ini':
            cmdDumpIni(args);
            break;
        default:
            process.stderr.write(`Unknown subcommand: ${args.subcommand}\n`);
            cmdHelp();
            process.exit(1);
    }
}

main().catch((err) => {
    process.stderr.write(`CLI error: ${err.stack || err.message}\n`);
    process.exit(1);
});
