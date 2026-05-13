'use strict';

const { validateProfile } = require('./schema');

/** 3-channel RGB LED. */
module.exports = validateProfile({
    name:         'rgb',
    channels:     ['red', 'green', 'blue'],
    capabilities: ['dimmer', 'color'],
});
