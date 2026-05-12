'use strict';

const { OpenDmxInterface }  = require('./opendmx');
const { EnttecProInterface } = require('./enttec-pro');

const INTERFACE_MAP = {
    'opendmx':    OpenDmxInterface,
    'enttec-pro': EnttecProInterface,
};

/**
 * Names of known DMX interface types (for schema validation).
 */
const VALID_DMX_INTERFACES = Object.keys(INTERFACE_MAP);

/**
 * Create a DMX interface instance by name.
 *
 * @param {string} name  - Interface identifier: 'opendmx' | 'enttec-pro'
 * @returns {OpenDmxInterface|EnttecProInterface}
 * @throws {Error} If name is not recognised.
 */
function createInterface(name) {
    const Cls = INTERFACE_MAP[name];
    if (!Cls) {
        throw new Error(
            `Unknown DMX interface "${name}". Valid options: ${VALID_DMX_INTERFACES.join(', ')}`
        );
    }
    return new Cls();
}

module.exports = { createInterface, VALID_DMX_INTERFACES };
