'use strict';

const { validateProfile } = require('./schema');

/** 4-channel RGBA LED (red, green, blue, amber). */
module.exports = validateProfile({
    name:         'rgba',
    channels:     ['red', 'green', 'blue', 'amber'],
    capabilities: ['dimmer', 'color'],
});
