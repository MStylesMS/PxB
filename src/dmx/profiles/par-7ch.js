'use strict';

const { validateProfile } = require('./schema');

/**
 * 7-channel common cheap LED par can.
 * CH1: dimmer (master intensity)
 * CH2: red
 * CH3: green
 * CH4: blue
 * CH5: strobe (0 = off, 1–255 = slow → fast)
 * CH6: mode   (0–7 = static, 8–127 = colour macros, 128–255 = sound-active — pin to 0)
 * CH7: speed  (macro speed for mode > 7)
 *
 * defaults: mode = 0 (static/manual colour control); speed = 0.
 */
module.exports = validateProfile({
    name:         'par-7ch',
    channels:     ['dimmer', 'red', 'green', 'blue', 'strobe', 'mode', 'speed'],
    capabilities: ['dimmer', 'color', 'strobe', 'mode'],
    defaults:     { mode: 0, speed: 0, strobe: 0 },
});
