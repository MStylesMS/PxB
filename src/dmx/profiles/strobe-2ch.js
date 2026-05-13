'use strict';

const { validateProfile } = require('./schema');

/**
 * Two-channel strobe light.
 *
 * CH1: strobe rate / speed (0 = off, 1 = slowest, 255 = fastest continuous).
 * CH2: dimmer / intensity (0 = off, 255 = full brightness when strobing).
 *
 * Typical use: set dimmer to desired intensity via setIntensity,
 * then trigger via burst/pulse.  The strobe rate is set from the
 * adapter's strobe_rate config key (default 128 = medium).
 *
 * Map to [effect:<label>] with fixture = strobe-2ch.
 * Use DmxEffectAdapter commands: burst, stop, setIntensity.
 */
module.exports = validateProfile({
    name:         'strobe-2ch',
    channels:     ['strobe', 'dimmer'],
    capabilities: ['strobe', 'dimmer', 'effect'],
    defaults:     { strobe: 0, dimmer: 0 },
});
