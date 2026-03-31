# Changelog

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
