'use strict';

const { validateProfile } = require('./schema');

/**
 * Two-channel hazer (haze / atmospheric machine).
 *
 * CH1: haze output intensity (0 = off, 1–255 = haze; 255 = maximum).
 * CH2: fan speed (0 = off, 255 = maximum fan dispersion).
 *
 * A hazer produces a fine continuous mist rather than dense fog clouds.
 * The fan channel controls how widely the haze is dispersed through the space.
 * For a subtle ambient haze, run CH1 at 20–60 with fan at 40–80.
 *
 * Map to [effect:<label>] with fixture = hazer-2ch.
 * Use DmxEffectAdapter commands: burst, stop, setIntensity.
 */
module.exports = validateProfile({
    name:         'hazer-2ch',
    channels:     ['dimmer', 'speed'],
    capabilities: ['dimmer', 'effect'],
    defaults:     { dimmer: 0, speed: 0 },
});
