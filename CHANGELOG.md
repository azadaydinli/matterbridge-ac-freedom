# Changelog

## 1.0.7 (2026-04-02)

- **HomeKit fix**: Reverted fan to child endpoint with `fanDevice` (FanControl on thermostat endpoint was not supported). Thermostat remains the main device type — should display as climate card.
- **Config UI fix**: Removed nested "Features" section. "Extra Controls" checkbox is now at the same level as other fields (no visual separation).
- **Extra Controls**: Single checkbox enables both fan speed control and sleep mode switch as child endpoints under the thermostat.

## 1.0.6 (2026-04-02)

- **HomeKit fix**: FanControl cluster now added directly to the thermostat endpoint instead of as a child device, so the device appears as a climate card (not a fan card) in HomeKit.
- **Simplified config**: Removed Display switch. Fan Control and Sleep Mode merged into a single "Extra Controls" checkbox.
- **Schema**: Temperature Step moved above Features section.

## 1.0.5 (2026-04-01)

- **Simplified features**: Removed ComfWind, Health/Ionizer, Eco/Mildew, and Self Clean. Only Fan Control, Display Switch, and Sleep Mode remain as optional features.
- **Merged config sections**: "Preset Modes" removed; all optional features now under a single "Features" heading.

## 1.0.2 (2026-04-01)

- **Composed device**: Fan and switches are now child endpoints of the thermostat, so all controls appear under a single device in Apple Home, Google Home, etc.
- **Schema fixes**: Fixed `required` validation error; flattened cloud/local/preset config fields for Matterbridge frontend compatibility.
- **Password field**: Cloud password now uses `ui:widget: "password"` for masked input.

## 1.0.1 (2026-04-01)

- Fixed config schema validation errors.
- Flattened nested config objects for Matterbridge frontend support.

## 1.0.0 (2026-04-01)

- Initial release.
- Thermostat device with Heat / Cool / Auto modes.
- Fan device with speed control (Auto, Mute, Low, Medium, High, Turbo).
- Preset switches: Sleep, Health, Eco, Clean (mutually exclusive).
- Feature switches: Comfortable Wind, Display.
- Cloud connection via BroadLink SmartHomeCS (EU, USA, CN, RUS regions).
- Local connection via Broadlink UDP protocol.
- 30-second polling interval with automatic token refresh.
