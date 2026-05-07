# Zooz ZSE41 800LR Open/Close XS Sensor

Back to spec: [Supported Devices in SPEC](../SPEC.md#19-supported-devices)

## Summary

- Vendor: Zooz (The Smartest House)
- Model: ZSE41 800LR Open/Close XS Sensor
- Protocol: Z-Wave (800 series, LR-capable model family)
- Device class in PxB: contact
- Intended use in PxB: door/window open-close event source for input mapping

This profile documents operational notes for using the ZSE41 model family with PxB in contact-sensor workflows.

## Pairing and Inclusion

1. Ensure PxB is running and inclusion mode is active:
   - MQTT: send startInclusion on the bridge command topic.
   - CLI: use the equivalent include command.
2. On the sensor, initiate pairing using the device button sequence.
   - In current room testing, the working trigger sequence is pressing the pairing button three times quickly.
3. Watch for:
   - bridge state transition to inclusion active
   - discovery message on the discovered topic
   - node state updates for the device label after interview

## Exclusion and Re-inclusion

1. Start exclusion mode from PxB.
2. Trigger the sensor exclusion action (same device button interaction family as inclusion).
3. Confirm node removal in bridge state and logs.
4. Re-run inclusion and update node_id in config if the controller assigns a new node number.

## Operation Notes in PxB

- As a battery-powered contact sensor, the device can sleep between events.
- Typical wake behavior in this environment:
  - open/close activity wakes and transmits
  - manual pairing button interaction wakes and transmits
- If events are missing:
  - verify single PxB process ownership of the radio
  - verify bridge state and inclusion/interview status
  - run refreshNode and then trigger the sensor physically

## Recommended Monitoring During Validation

- MQTT:
  - bridge state, warnings, discovered
  - node events and node state
- Logs:
  - PxB runtime log with signal, inclusion FSM, and publish lines

## Official Links

- Zooz support landing page for ZSE41 family: https://www.support.getzooz.com/kb/section/261/
- ZSE41 specs article: https://www.support.getzooz.com/kb/article/981-zse41-open-close-xs-sensor-specs/?section_id=261
- ZSE41 FAQs: https://www.support.getzooz.com/kb/article/1335-zse41-open-close-xs-sensor-faqs/?section_id=261
- ZSE41 hard reset article: https://www.support.getzooz.com/kb/article/847-how-do-i-perform-hard-reset-on-my-zse41-open-close-xs-sensor/?section_id=261
- ZSE41 advanced settings article: https://www.support.getzooz.com/kb/article/748-zse41-open-close-xs-sensor-advanced-settings/?section_id=261
