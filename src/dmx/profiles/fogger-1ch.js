'use strict';

const { validateProfile } = require('./schema');

/**
 * Single-channel fogger / smoke machine.
 *
 * CH1: output intensity (0 = off, 1–255 = fog; 255 = maximum output).
 *
 * Map to [effect:<label>] with fixture = fogger-1ch.
 * Use DmxEffectAdapter commands: burst, stop, setIntensity.
 */
module.exports = validateProfile({
    name:         'fogger-1ch',
    channels:     ['dimmer'],
    capabilities: ['dimmer', 'effect'],
    defaults:     { dimmer: 0 },
});
