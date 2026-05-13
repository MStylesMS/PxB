'use strict';
const { validateProfile } = require('./schema');

// 8-channel wash moving head.
// Typical layout for entry-level LED wash movers (e.g., ADJ Vizi Wash Z19,
// Chauvet SlimPAR Pro H USB in move mode, generic 8CH RGB mover):
//
//   CH1  pan     Pan position       0 = left, 128 = centre, 255 = right
//   CH2  tilt    Tilt position      0 = front, 128 = straight, 255 = back
//   CH3  speed   Movement speed     0 = fastest, 255 = slowest
//   CH4  dimmer  Master intensity   0 = off, 255 = full
//   CH5  strobe  Strobe rate        0 = off, 1–255 = slow to fast
//   CH6  red     Red component      0–255
//   CH7  green   Green component    0–255
//   CH8  blue    Blue component     0–255
//
// Pan/tilt accept 8-bit coarse values. For 16-bit resolution use mover-12ch.

module.exports = validateProfile({
    name:         'mover-8ch',
    channels:     ['pan', 'tilt', 'speed', 'dimmer', 'strobe', 'red', 'green', 'blue'],
    capabilities: ['pan', 'tilt', 'dimmer', 'color', 'strobe'],
    defaults:     { speed: 0, strobe: 0 },
});
