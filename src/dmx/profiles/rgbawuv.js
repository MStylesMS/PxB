'use strict';

const { validateProfile } = require('./schema');

/** 6-channel RGBAWUV LED (red, green, blue, amber, white, UV). */
module.exports = validateProfile({
    name:         'rgbawuv',
    channels:     ['red', 'green', 'blue', 'amber', 'white', 'uv'],
    capabilities: ['dimmer', 'color', 'colorTemp'],
});
