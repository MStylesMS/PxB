'use strict';
const { validateProfile } = require('./schema');

// 12-channel advanced moving head with 16-bit pan/tilt resolution.
// Typical layout for mid-range spot movers (e.g., Chauvet Intimidator Spot 155,
// American DJ Focus Spot Two, generic 12CH mover):
//
//   CH1  pan       Pan (coarse)       0 = left, 128 = centre, 255 = right
//   CH2  pan_fine  Pan (fine)         16-bit extension of CH1
//   CH3  tilt      Tilt (coarse)      0 = front, 128 = straight, 255 = back
//   CH4  tilt_fine Tilt (fine)        16-bit extension of CH3
//   CH5  speed     Movement speed     0 = fastest, 255 = slowest
//   CH6  dimmer    Master intensity   0 = off, 255 = full
//   CH7  strobe    Strobe rate        0 = off, 1–255 = slow to fast
//   CH8  red       Red component      0–255
//   CH9  green     Green component    0–255
//   CH10 blue      Blue component     0–255
//   CH11 gobo      Gobo wheel         0 = open, values vary by fixture
//   CH12 mode      Fixture mode pin   see fixture manual (often 0 = default)
//
// For moveTo commands, pan_fine and tilt_fine are set to 0. For full 16-bit
// precision, use raw setChannel commands via a custom integration.

module.exports = validateProfile({
    name:         'mover-12ch',
    channels:     ['pan', 'pan_fine', 'tilt', 'tilt_fine', 'speed', 'dimmer', 'strobe', 'red', 'green', 'blue', 'gobo', 'mode'],
    capabilities: ['pan', 'tilt', 'dimmer', 'color', 'strobe', 'gobo', 'mode'],
    defaults:     { speed: 0, strobe: 0, gobo: 0, mode: 0 },
});
