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
        '  status       Print current bridge status (reads from MQTT)\n' +
        '  list-nodes   Print configured nodes from INI (no broker needed)\n' +
        '  help         Show this help\n\n' +
        'Options:\n' +
        '  --config, -c <path>   Path to pzb.ini  (required)\n' +
        '  --timeout <ms>        Timeout for status command (default: 5000)\n'
    );
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
