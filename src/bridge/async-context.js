'use strict';

/**
 * async-context.js — Thin wrapper around AsyncLocalStorage for subsystem attribution.
 *
 * Used by SubsystemRegistry to tag async call chains with a subsystem id so that
 * uncaught exceptions and unhandled rejections can be attributed to the originating
 * subsystem without adding explicit error-routing plumbing throughout the codebase.
 *
 * Usage:
 *   const { runInSubsystem, currentSubsystemId } = require('./async-context');
 *
 *   // In a timer callback that belongs to the 'zwave-driver' subsystem:
 *   setInterval(() => {
 *       runInSubsystem('zwave-driver', () => doWork());
 *   }, 1000);
 *
 *   // In the uncaughtException handler:
 *   const id = currentSubsystemId(); // → 'zwave-driver' if we're inside that context
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const _store = new AsyncLocalStorage();

/**
 * Run fn() inside an async context tagged with the given subsystem id.
 * Any async operations initiated inside fn() inherit the tag automatically
 * (as long as they don't cross old-style callback chains that break async context).
 *
 * @param {string} id - Subsystem identifier (e.g. 'zwave-driver')
 * @param {function} fn - Synchronous or async function to run in context
 * @returns {*} Return value of fn()
 */
function runInSubsystem(id, fn) {
    return _store.run({ subsystemId: id }, fn);
}

/**
 * Return the subsystem id for the current async context, or null if untagged.
 *
 * @returns {string|null}
 */
function currentSubsystemId() {
    const store = _store.getStore();
    return store ? store.subsystemId : null;
}

module.exports = { runInSubsystem, currentSubsystemId };
