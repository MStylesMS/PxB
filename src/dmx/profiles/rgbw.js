'use strict';

const { validateProfile } = require('./schema');

/** 4-channel RGBW LED (red, green, blue, white). */
module.exports = validateProfile({
    name:         'rgbw',
    channels:     ['red', 'green', 'blue', 'white'],
    capabilities: ['dimmer', 'color', 'colorTemp'],
});
