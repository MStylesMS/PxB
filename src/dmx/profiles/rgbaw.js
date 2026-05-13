'use strict';

const { validateProfile } = require('./schema');

/** 5-channel RGBAW LED (red, green, blue, amber, white). */
module.exports = validateProfile({
    name:         'rgbaw',
    channels:     ['red', 'green', 'blue', 'amber', 'white'],
    capabilities: ['dimmer', 'color', 'colorTemp'],
});
