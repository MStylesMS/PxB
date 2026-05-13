'use strict';

const { validateProfile } = require('./schema');

/**
 * Two-channel fogger / smoke machine.
 *
 * CH1: output intensity (0 = off, 1–255 = fog; 255 = maximum output).
 * CH2: fan / air speed (0 = off, 255 = maximum fan).  On many machines this
 *      controls how forcefully fog is projected; set to 0 for a drifting
 *      cloud effect, higher values for a directed jet.
 *
 * Map to [effect:<label>] with fixture = fogger-2ch.
 * Use DmxEffectAdapter commands: burst, stop, setIntensity.
 */
module.exports = validateProfile({
    name:         'fogger-2ch',
    channels:     ['dimmer', 'speed'],
    capabilities: ['dimmer', 'effect'],
    defaults:     { dimmer: 0, speed: 0 },
});
