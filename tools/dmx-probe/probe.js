#!/usr/bin/env node
/**
 * tools/dmx-probe/probe.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase-0 hardware validation script for the USB-to-DMX cable (FTDI FT232R).
 * Drives a 6-channel RGBW LED PAR fixture at DMX address 1 through a colour
 * cycle to prove the cable works before PxB integration begins.
 *
 * Usage:
 *   node tools/dmx-probe/probe.js [device]
 *   node tools/dmx-probe/probe.js /dev/ttyUSB3
 *   node tools/dmx-probe/probe.js /dev/serial/by-id/usb-FTDI_FT232R_USB_UART_B002JE1K-if00-port0
 *
 * If [device] is omitted, the script scans for a connected FTDI FT232R.
 *
 * Fixture setup:  DMX address = 1, mode = 6CH DMX.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { SerialPort } = require('serialport');

// ── Constants ──────────────────────────────────────────────────────────────────
const UNIVERSE_SIZE   = 512;          // DMX slots per frame
const FRAME_HZ        = 30;           // target frame rate (baud-switch overhead will lower actual Hz)
const FRAME_MS        = 1000 / FRAME_HZ;
const STEP_DURATION_S = 3;            // seconds per colour step
const TOTAL_STEPS     = 7;            // number of colour steps (see sequence below)
const LOAD_SOAK_S     = 30;           // seconds to keep last step while user runs stress

// ── Fixture: 6-CH RGBW LED PAR at DMX address 1 ───────────────────────────────
//  CH1  Master (240 = independent RGBW control, 0 = off)
//  CH2  Red   0–255
//  CH3  Green 0–255
//  CH4  Blue  0–255
//  CH5  White 0–255
//  CH6  Program (0 = no program; leave 0 for manual validation)
//
//  All addresses are 1-indexed; frame[address] maps to slot address-1+1 in the
//  raw 513-byte buffer (byte 0 = start code).

const sequence = [
  { name: 'INIT (blackout 3 s)',     ch: { 1: 0,   2: 0,   3: 0,   4: 0,   5: 0,   6: 0 } },
  { name: 'MASTER ON (dimmer test)', ch: { 1: 100,  2: 0,   3: 0,   4: 0,   5: 0,   6: 0 } },
  { name: 'RED',                     ch: { 1: 240,  2: 255, 3: 0,   4: 0,   5: 0,   6: 0 } },
  { name: 'GREEN',                   ch: { 1: 240,  2: 0,   3: 255, 4: 0,   5: 0,   6: 0 } },
  { name: 'BLUE',                    ch: { 1: 240,  2: 0,   3: 0,   4: 255, 5: 0,   6: 0 } },
  { name: 'WHITE',                   ch: { 1: 240,  2: 0,   3: 0,   4: 0,   5: 255, 6: 0 } },
  { name: 'RGBW (all on, soak)',     ch: { 1: 240,  2: 200, 3: 100, 4: 100, 5: 200, 6: 0 } },
];

// ── DMX frame buffer (start code 0x00 + 512 data bytes) ───────────────────────
const frame = Buffer.alloc(UNIVERSE_SIZE + 1, 0);
// frame[0] = start code = 0x00 (already 0)

function setChannels(channelMap) {
  // zero all channels first, then apply the step
  frame.fill(0, 1);
  for (const [addr, val] of Object.entries(channelMap)) {
    const idx = parseInt(addr, 10);
    if (idx >= 1 && idx <= UNIVERSE_SIZE) {
      frame[idx] = val & 0xff;
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openPort(path, baudRate, stopBits) {
  const p = new SerialPort({ path, baudRate, dataBits: 8, stopBits, parity: 'none', autoOpen: false });
  return new Promise((resolve, reject) => p.open((err) => err ? reject(err) : resolve(p)));
}

function closePort(p) {
  return new Promise((resolve, reject) => {
    p.drain((err) => {
      if (err) return reject(err);
      p.close(resolve);
    });
  });
}

function writeAndDrain(p, buf) {
  return new Promise((resolve, reject) => {
    p.write(buf, (err) => {
      if (err) return reject(err);
      p.drain(resolve);
    });
  });
}

// BREAK via baud-rate switch (Open DMX method — reliable on FTDI FT232R + Linux)
//
// One 0x00 byte at 76800 baud 8N1 holds the line LOW for ~104 µs (> 88 µs spec).
// Re-opening at 250000 baud leaves TX idle (HIGH) — that IS the MAB.
// port.set({brk:true/false}) is NOT used: it is unreliable with the ftdi_sio
// driver on this Pi and produces only occasional valid frames.
async function sendFrame(devicePath) {
  const brkPort = await openPort(devicePath, 76800, 1);
  await writeAndDrain(brkPort, Buffer.from([0x00]));
  await closePort(brkPort);

  const dmxPort = await openPort(devicePath, 250000, 2);
  await writeAndDrain(dmxPort, frame);
  await closePort(dmxPort);
}

async function findFtdiDevice() {
  const ports = await SerialPort.list();
  const ftdi = ports.find(
    (p) =>
      (p.vendorId === '0403' && p.productId === '6001') ||
      (p.manufacturer && p.manufacturer.toLowerCase().includes('ftdi'))
  );
  return ftdi ? ftdi.path : null;
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  let devicePath = process.argv[2];

  if (!devicePath) {
    process.stdout.write('Scanning for FTDI FT232R...\n');
    devicePath = await findFtdiDevice();
    if (!devicePath) {
      const ports = await SerialPort.list();
      console.error('\nNo FTDI device found. Detected serial ports:');
      if (ports.length === 0) {
        console.error('  (none)');
      } else {
        for (const p of ports) {
          console.error(`  ${p.path}  vendor=${p.vendorId} product=${p.productId} mfr=${p.manufacturer || '?'}`);
        }
      }
      console.error('\nPass the device path explicitly:');
      console.error('  node tools/dmx-probe/probe.js /dev/ttyUSB3');
      process.exit(1);
    }
    console.log(`Found FTDI device at: ${devicePath}`);
  }

  console.log(`\nUsing ${devicePath} — baud-switch BREAK method (Open DMX)`);
  console.log('Starting DMX output.\n');
  console.log('Fixture: 6-CH RGBW LED PAR at DMX address 1 in 6CH mode.');
  console.log(`Frame rate: ~${FRAME_HZ} Hz  |  Step duration: ${STEP_DURATION_S} s\n`);

  let frameCount  = 0;
  let stepIndex   = 0;
  let stepStart   = Date.now();
  let running     = true;
  const lastStepIdx = sequence.length - 1;

  // Apply first step immediately
  setChannels(sequence[0].ch);
  console.log(`► Step 0/${sequence.length - 1}: ${sequence[0].name}`);

  const frameLoop = async () => {
    while (running) {
      const loopStart = Date.now();

      // Advance step?
      const stepAge = (Date.now() - stepStart) / 1000;
      const isLastStep = stepIndex === lastStepIdx;
      const stepDuration = isLastStep ? STEP_DURATION_S + LOAD_SOAK_S : STEP_DURATION_S;

      if (stepAge >= stepDuration) {
        if (isLastStep) {
          // All steps done — send all-off and exit
          setChannels({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 });
          await sendFrame(devicePath);
          running = false;
          break;
        }
        stepIndex++;
        stepStart = Date.now();
        setChannels(sequence[stepIndex].ch);
        console.log(`► Step ${stepIndex}/${sequence.length - 1}: ${sequence[stepIndex].name}`);
      }

      try {
        await sendFrame(devicePath);
        frameCount++;
      } catch (err) {
        console.error(`Frame send error (frame ${frameCount}):`, err.message);
      }

      // Pace to FRAME_HZ — baud-switch overhead means actual Hz will be lower
      const elapsed = Date.now() - loopStart;
      const wait = FRAME_MS - elapsed;
      if (wait > 0) await sleep(wait);
    }
  };

  // Clean exit on Ctrl+C
  process.on('SIGINT', async () => {
    console.log('\n\nSIGINT — sending all-off...');
    setChannels({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 });
    try {
      await sendFrame(devicePath);
    } catch (_) { /* ignore */ }
    running = false;
  });

  const startTime = Date.now();
  await frameLoop();

  const totalS  = ((Date.now() - startTime) / 1000).toFixed(1);
  const avgFps  = (frameCount / parseFloat(totalS)).toFixed(1);

  console.log(`\nDone. Frames sent: ${frameCount}  Time: ${totalS} s  Avg FPS: ${avgFps}`);
  console.log('\n─── Record these results in docs/pending/PR_DMX_SUPPORT.md Phase 0 ───');
  console.log(`  Date            : ${new Date().toISOString().slice(0,10)}`);
  console.log(`  Device          : ${devicePath}`);
  console.log(`  Avg FPS         : ${avgFps}`);
  console.log(`  Fixture response: (fill in — did each colour step fire correctly?)`);
  console.log(`  Load test       : (fill in — run stress -c 4 during the RGBW soak step)`);
})();
