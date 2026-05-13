#!/usr/bin/env node
'use strict';

/**
 * DMX Demo — four visual sequences sent over MQTT.
 *
 * Usage:
 *   node tools/dmx-demo/demo.js [--broker mqtt://localhost] [--topic paradox/pxb/lights/dmx1]
 *
 * Each sequence runs in order:
 *   1. Fade  — white on→full brightness over 2.5 s, then off over 2.5 s
 *   2. Color cycle — fade through a rainbow of named colors
 *   3. Strobe ramp — per-color strobe sweeping 0.5 → 15 → 0.5 Hz
 *   4. Disco  — random colors at 1 → 15 → 1 Hz strobe
 *
 * The demo ends with stopStrobe to leave the fixture dark.
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

async function seq1_fade(client) {
    log('Sequence 1: Fade white on→off');

    // Fade from off (0%) to full white over 2.5 s
    send(client, {
        command: 'setColor',
        color: { r: 255, g: 255, b: 255 },
        brightness: 100,
        fadeTime: 2.5,
    });
    await sleep(3000);

    // Fade off over 2.5 s
    send(client, { command: 'off', fadeTime: 2.5 });
    await sleep(3000);
}

async function seq2_colorCycle(client) {
    log('Sequence 2: Color cycle');

    const colors = [
        { color: { r: 255, g: 0,   b: 0   }, label: 'red',    fadeTime: 1.5 },
        { color: { r: 255, g: 100, b: 0   }, label: 'orange', fadeTime: 1.2 },
        { color: { r: 255, g: 220, b: 0   }, label: 'yellow', fadeTime: 1.2 },
        { color: { r: 0,   g: 255, b: 0   }, label: 'green',  fadeTime: 1.5 },
        { color: { r: 0,   g: 100, b: 255 }, label: 'blue',   fadeTime: 1.5 },
        { color: { r: 170, g: 60,  b: 255 }, label: 'purple', fadeTime: 1.2 },
        { color: { r: 255, g: 255, b: 255 }, label: 'white',  fadeTime: 1.0 },
        { color: { r: 0,   g: 0,   b: 0   }, label: 'off',    fadeTime: 2.0 },
    ];

    for (const step of colors) {
        log(`  → ${step.label} (fadeTime: ${step.fadeTime}s)`);
        send(client, {
            command: 'setColor',
            color: step.color,
            brightness: 90,
            fadeTime: step.fadeTime,
        });
        await sleep(step.fadeTime * 1000 + 600);
    }
}

async function seq3_strobeRamp(client) {
    log('Sequence 3: Strobe ramp per color');

    const colors = [
        { r: 255, g: 0,   b: 0,   name: 'red'   },
        { r: 0,   g: 255, b: 0,   name: 'green' },
        { r: 0,   g: 0,   b: 255, name: 'blue'  },
        { r: 255, g: 255, b: 255, name: 'white' },
    ];

    for (const c of colors) {
        log(`  Strobe ramp: ${c.name}`);

        // Ramp from 0.5 Hz → 15 Hz over ~5 s
        const steps = 10;
        for (let i = 0; i <= steps; i++) {
            const hz = 0.5 + (15 - 0.5) * (i / steps);
            send(client, {
                command: 'setStrobe',
                strobeHz: Math.round(hz * 10) / 10,
                strobeDuty: 50,
                color: { r: c.r, g: c.g, b: c.b },
                brightness: 100,
            });
            await sleep(500);
        }

        // Ramp back down from 15 Hz → 0.5 Hz
        for (let i = steps; i >= 0; i--) {
            const hz = 0.5 + (15 - 0.5) * (i / steps);
            send(client, {
                command: 'setStrobe',
                strobeHz: Math.round(hz * 10) / 10,
                strobeDuty: 50,
                color: { r: c.r, g: c.g, b: c.b },
                brightness: 100,
            });
            await sleep(500);
        }

        send(client, { command: 'stopStrobe' });
        await sleep(800);
    }
}

async function seq4_disco(client) {
    log('Sequence 4: Disco');

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

    const totalMs = 20000;
    const stepMs  = 300;
    const steps   = totalMs / stepMs;

    for (let i = 0; i < steps; i++) {
        // Hz ramps 1→15→1 as a triangle wave over totalMs
        const t  = i / steps;
        const hz = t < 0.5
            ? 1 + (15 - 1) * (t / 0.5)
            : 15 + (1 - 15) * ((t - 0.5) / 0.5);

        const color = palette[Math.floor(Math.random() * palette.length)];

        send(client, {
            command: 'setStrobe',
            strobeHz: Math.round(hz * 10) / 10,
            strobeDuty: 40 + Math.round(Math.random() * 30),
            color,
            brightness: 100,
        });
        await sleep(stepMs);
    }

    send(client, { command: 'stopStrobe' });
    await sleep(500);
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

        await seq1_fade(client);
        await seq2_colorCycle(client);
        await seq3_strobeRamp(client);
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
