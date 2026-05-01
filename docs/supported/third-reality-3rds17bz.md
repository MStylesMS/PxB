# Third Reality 3RDS17BZ Door Sensor

Back to spec: [Supported Devices in SPEC](../SPEC.md#19-supported-devices)

## Summary

- Vendor: Third Reality
- Model: 3RDS17BZ
- Protocol: Zigbee
- PxB class: contact
- Status: PxB support implemented (PxB phase 3); hardware validation pending

This profile is staged ahead of Zigbee phase work so the team can track model-specific pairing and compatibility notes in one place.

## Pairing Workflow (PxB Zigbee)

1. Enable Zigbee radio support in PxB config for the target coordinator.
2. Start Zigbee inclusion mode from bridge commands.
3. Trigger pairing mode on the 3RDS17BZ sensor.
4. Confirm discovery topic output and generated config fragment.
5. Promote discovered entry to a named node section with final base_topic and label.

## Planned Validation Checklist

- Join and interview completes without errors.
- Open/close events publish with stable token mapping.
- Battery and reachable signals appear when available.
- Rejoin after battery pull or reset works without duplicate ghost nodes.

## Official Links

- Third Reality device support portal: https://thirdreality.com/devicesupport
- Third Reality smart door sensor product page: https://thirdreality.com/collections/all/products/thirdreality-smart-door-sensor
