#!/usr/bin/env node
'use strict';

/**
 * DMX Demo — three visual sequences sent over MQTT.
 *
 * Usage:
 *   node tools/dmx-demo/demo.js [--broker mqtt://localhost] [--topic paradox/pxb/lights/dmx1]
 *
 * Each sequence runs in order:
 *   1. Color fades — four colors, each fading in and out over 5 s
 *   2. Strobe grid — step through every frame-aligned Hz value (up then down), 2 s each
 *   4. Disco       — random color at 5 Hz strobe for 10 s
 *
 * The demo ends with the fixture left dark.
 */

const mqtt  = require('mqtt');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('broker', { type: 'string', default: 'mqtt://localhost', describe: 'MQTT broker URL' })
    .option('topic',  { type: 'string', default: 'paradox/pxb/lights/dmx1', describe: 'Light zone topic' })
    .option('verbose', { alias: 'v', type: 'boolean', default: false })
    .help()
    .parse();

const cmdTopic = `${argv.topic}/commands`;

// Hz values that divide evenly into the 30 Hz DMX frame rate so strobe
// transitions land exactly on a frame boundary.  30 / hz must be an integer.
const RAMP_HZ = [1, 1.5, 2, 2.5, 3, 5, 7.5, 10, 15];
const log = (...a) => console.log('[demo]', ...a);
const dbg = (...a) => argv.verbose && console.log('[demo:dbg]', ...a);

// ── Helpers ───────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function send(client, payload) {
    const msg = JSON.stringify(payload);
    dbg('→', msg);
    client.publish(cmdTopic, msg, { qos: 0 });
}

// ── Sequences ─────────────────────────────────────────────────────────────

async function seq1_colorFades(client) {
    log('Sequence 1: Color fades (5 s fade-in, 5 s fade-out each)');

    const colors = [
        { color: { r: 255, g: 0,   b: 0   }, label: 'red'   },
        { color: { r: 0,   g: 100, b: 255 }, label: 'blue'  },
        { color: { r: 0,   g: 255, b: 0   }, label: 'green' },
        { color: { r: 255, g: 255, b: 255 }, label: 'white' },
    ];

    for (const step of colors) {
        log(`  → ${step.label}`);
        send(client, { command: 'setColor', color: step.color, brightness: 100, fadeTime: 5 });
        await sleep(5500);
        send(client, { command: 'off', fadeTime: 5 });
        await sleep(5500);
    }
}

async function seq2_colorFadeChain(client) {
    log('Sequence 2: Color fade chain (w→r→g→b→r→off, 2 s each)');

    const steps = [
        { color: { r: 255, g: 255, b: 255 }, label: 'white' },
        { color: { r: 255, g: 0,   b: 0   }, label: 'red'   },
        { color: { r: 0,   g: 255, b: 0   }, label: 'green' },
        { color: { r: 0,   g: 0,   b: 255 }, label: 'blue'  },
        { color: { r: 255, g: 0,   b: 0   }, label: 'red'   },
    ];

    for (const step of steps) {
        log(`  → ${step.label}`);
        send(client, { command: 'setColor', color: step.color, brightness: 100, fadeTime: 2 });
        await sleep(2100);
    }

    log('  → off');
    send(client, { command: 'off', fadeTime: 2 });
    await sleep(2500);
}

async function seq3_strobeGrid(client) {
    log('Sequence 3: Strobe grid — all frame-aligned Hz values, 2 s each');

    // Every valid Hz that lands on an integer frame count at 30 Hz,
    // from 1 Hz up to 15 Hz then back down.
    const upDown = [...RAMP_HZ, ...RAMP_HZ.slice(0, -1).reverse()];

    for (const hz of upDown) {
        log(`  strobeHz: ${hz}`);
        send(client, {
            command: 'setStrobe',
            strobeHz: hz,
            strobeDuty: 50,
            color: { r: 255, g: 255, b: 255 },
            brightness: 100,
        });
        await sleep(2000);
    }

    send(client, { command: 'stopStrobe' });
    await sleep(500);
}

async function seq4_disco(client) {
    log('Sequence 4: Disco — random color at 5 Hz strobe for 10 s');

    const palette = [
        { r: 255, g: 0,   b: 0   },
        { r: 0,   g: 255, b: 0   },
        { r: 0,   g: 0,   b: 255 },
        { r: 255, g: 220, b: 0   },
        { r: 0,   g: 220, b: 255 },
        { r: 170, g: 60,  b: 255 },
        { r: 255, g: 105, b: 180 },
        { r: 255, g: 255, b: 255 },
    ];

    const durationMs = 10000;
    const stepMs     = 200;   // new color every 5 Hz strobe period
    const steps      = Math.round(durationMs / stepMs);

    for (let i = 0; i < steps; i++) {
        const color = palette[Math.floor(Math.random() * palette.length)];
        send(client, {
            command: 'setStrobe',
            strobeHz: 5,
            strobeDuty: 50,
            color,
            brightness: 100,
        });
        await sleep(stepMs);
    }

    send(client, { command: 'stopStrobe' });
    await sleep(300);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
    log(`Connecting to ${argv.broker} …`);
    const client = mqtt.connect(argv.broker);

    await new Promise((res, rej) => {
        client.once('connect', res);
        client.once('error',   rej);
    });
    log(`Connected. Sending commands to ${cmdTopic}`);

    try {
        // Ensure we start dark
        send(client, { command: 'off' });
        await sleep(500);

        await seq1_colorFades(client);
        await seq2_colorFadeChain(client);
        await seq3_strobeGrid(client);
        await seq4_disco(client);

        log('Demo complete. Fixture left dark.');
    } finally {
        client.end();
    }
}

main().catch((err) => {
    console.error('[demo] Fatal:', err.message);
    process.exit(1);
});
