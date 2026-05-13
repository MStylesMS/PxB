'use strict';

const { validateProfile } = require('./schema');

/** Single-channel intensity dimmer. */
module.exports = validateProfile({
    name:         'dimmer',
    channels:     ['dimmer'],
    capabilities: ['dimmer'],
});
