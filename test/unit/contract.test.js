'use strict';

const { bridgeTopics, nodeTopics } = require('../../src/mqtt/contract');

describe('bridgeTopics', () => {
  const bt = bridgeTopics('paradox/houdini');

  test('status topic', () => expect(bt.status).toBe('paradox/houdini/pzb/status'));
  test('commands topic', () => expect(bt.commands).toBe('paradox/houdini/pzb/commands'));
  test('warnings topic', () => expect(bt.warnings).toBe('paradox/houdini/pzb/warnings'));
  test('discoveredRoot',  () => expect(bt.discoveredRoot).toBe('paradox/houdini/pzb/discovered'));
  test('discovered()', () => expect(bt.discovered('zwave', 3)).toBe('paradox/houdini/pzb/discovered/zwave/3'));
});

describe('nodeTopics', () => {
  const nt = nodeTopics('paradox/houdini/zwave/spell-box');

  test('events', ()   => expect(nt.events).toBe('paradox/houdini/zwave/spell-box/events'));
  test('state', ()    => expect(nt.state).toBe('paradox/houdini/zwave/spell-box/state'));
  test('commands', () => expect(nt.commands).toBe('paradox/houdini/zwave/spell-box/commands'));
  test('warnings', () => expect(nt.warnings).toBe('paradox/houdini/zwave/spell-box/warnings'));
});
