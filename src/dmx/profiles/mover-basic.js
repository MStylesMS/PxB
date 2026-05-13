'use strict';

const { validateProfile } = require('./schema');

/**
 * Minimal 3-channel moving head.
 * CH1: pan   (0–255 = 0°–540° or fixture full range)
 * CH2: tilt  (0–255 = 0°–270° or fixture full range)
 * CH3: dimmer (master intensity; some movers omit this — use address+offset 2 for shutter)
 *
 * Phase 6 will expand this into mover-8ch and mover-12ch with pan_fine,
 * tilt_fine, speed, color wheel, and gobo wheel slots.
 */
module.exports = validateProfile({
    name:         'mover-basic',
    channels:     ['pan', 'tilt', 'dimmer'],
    capabilities: ['pan', 'tilt', 'dimmer'],
});
