# Changelog

## 2.1.2 (2026-05-03)

- **Fix new device categorised as switch when extras ON**: Fan and Sleep child endpoints are now added in `onConfigure` (after the thermostat is already registered as a climate card) instead of during `addDevice`. HomeKit commits to the climate-card category on first registration; children added afterwards appear inside the climate card without changing the category.

## 2.1.1 (2026-05-03)

- **Fix fan Low/High swap**: AUX AC `ac_mark` parameter uses an inverted scale (`ac_mark=1` is fast/High, `ac_mark=3` is slow/Low). All fan mode mappings corrected accordingly.

## 2.1.0 (2026-05-03)

- **Fix fan control not sending commands**: HomeKit writes to `percentSetting`, not only `fanMode`. Now subscribing to both attributes. Added `addRequiredClusterServers()` on fan and sleep child endpoints.
- **Fan pct mapping**: 0%=Auto, 25%=Low, 50%=Medium, 75%=High, 100%=Turbo.

## 2.0.9 (2026-05-03)

- **Reverted to v2.0.4 architecture**: Fan and Sleep are child endpoints of the thermostat again (`fanDevice` + `onOffSwitch`).
- **Fan mode sequence fixed**: Off=Auto → Low → Medium → High → Auto=Turbo. The `FanMode.Auto` position (fully open) maps to Turbo in the AC.

## 2.0.8 (2026-05-03)

- **Fan and sleep as standalone bridged devices**: HomeKit does not render child endpoints of a thermostat composed device. Fan speed (modeSelect) and Sleep Mode (onOffSwitch) are now registered as independent bridged devices — they will appear as separate tiles in HomeKit but are guaranteed to be visible and functional.

## 2.0.7 (2026-05-03)

- **Fan control: ModeSelect card**: Replaced `fanDevice` + FanControl cluster with `modeSelect` device type + ModeSelect cluster. HomeKit renders ModeSelect as a selectable mode card (Auto / Low / Medium / High), similar to the home mode selector card.

## 2.0.6 (2026-05-03)

- **Fan control: mode picker instead of slider**: Switched from `MultiSpeed` (slider) back to `fanMode`-based control. HomeKit renders `fanMode` as a discrete mode picker card (Auto / Low / Medium / High).

## 2.0.5 (2026-05-03)

- **Fan control: 4 discrete steps**: Fan speed is now a 4-step control (Auto → Low → Medium → High) instead of a free-sliding percentage. Uses `MultiSpeed` feature with `speedMax=3`.
- **Fan speed order fixed**: Step 0=Auto, 1=Low, 2=Medium, 3=High. Turbo removed.

## 2.0.4 (2026-05-03)

- **Fix fan and sleep not appearing**: `addChildDeviceType` creates the child endpoint but does not add cluster servers. Now `createDefaultFanControlClusterServer` and `createOnOffClusterServer` are explicitly called on the child endpoints after creation.

## 2.0.3 (2026-05-03)

- **Fix fan and sleep controls**: Fan speed and Sleep Mode are now added as child endpoints of the thermostat using `addChildDeviceType()`. This makes them appear inside the climate card in HomeKit, not as separate devices.
- **Fix sleep switch**: Sleep Mode no longer registers as a separate switch tile — it is a child of the thermostat composed device.

## 2.0.2 (2026-05-03)

- **Temperature step**: Changed fixed step from 1°C to 0.5°C.

## 2.0.1 (2026-05-03)

- **Remove tempStep config**: Temperature step is now fixed at 1°C. The dropdown was not rendering correctly in Matterbridge UI regardless of format.

## 2.0.0 (2026-05-03)

- **Complete rewrite**: Fully redesigned plugin architecture for stability and correctness.
- **HomeKit climate card guaranteed**: FanControl cluster is added directly to the thermostat endpoint (no fanDevice/onOffSwitch children). This ensures HomeKit always categorizes the device as a climate card regardless of configuration.
- **Sleep mode as separate device**: When `showExtras` is ON, Sleep Mode appears as a separate bridged switch device (not a child endpoint), avoiding HomeKit categorization conflicts.
- **Temperature step dropdown**: Fixed `tempStep` config to use a standard `enum` dropdown (0.5°C or 1°C) — the previous `oneOf` format was not selectable in some UI renderers.
- **New storage keys**: All devices use `acf2-` key prefix to force clean registration, clearing any cached device structures from v1.x.
- **Graceful connection failure**: Device is registered in Matterbridge immediately, even if the AC connection fails on startup. Polling retries every 30 seconds.
- **Connected flag**: Commands are only sent to the AC when the connection is confirmed active, preventing silent errors.
- **Debounce improved**: 500ms temperature debounce prevents multiple beeps when HomeKit fires both cooling and heating setpoint callbacks simultaneously.
- **Token refresh**: Cloud API automatically re-authenticates on token expiry.

## 1.0.12 (2026-04-03)

- **Fix device not appearing**: Device is now registered in Matterbridge even if the initial API connection fails. The polling loop will retry the connection.
- **Better logging**: Added discovery count, device registration, and connection failure messages to help diagnose issues.

## 1.0.11 (2026-04-03)

- **Fix multiple beeps**: Temperature commands are now debounced (500ms). HomeKit fires both cooling and heating setpoint callbacks simultaneously — debounce merges them into a single command to the AC.
- **Fix first-config extras**: Fan and Sleep Mode child endpoints are now ALWAYS created (regardless of showExtras). This ensures HomeKit always registers the device as a climate card on first setup. The showExtras config only controls whether fan/sleep attributes are actively synced with the AC.

## 1.0.10 (2026-04-02)

- **Temperature step fix**: `tempStep` config is now applied. When set to 1°C, temperatures are rounded to the nearest whole degree before sending to the AC. The rounded value is also written back to the Matter attribute so HomeKit UI reflects it (e.g. 24.5 → 25).

## 1.0.9 (2026-04-02)

- **Restored v1.0.2 composed device pattern**: Fan and Sleep Mode are child endpoints under the thermostat (same approach that worked in v1.0.2). When `showExtras` is ON, fan speed control + sleep mode switch appear inside the climate card. When OFF, only the thermostat is shown.
- **Sleep mode restored**: Sleep Mode switch is back as a child endpoint.

## 1.0.8 (2026-04-02)

- **HomeKit climate card fix**: Removed ALL child endpoints (no fanDevice, no onOffSwitch). FanControl cluster is added directly to the thermostat endpoint BEFORE `addRequiredClusterServers()` — this was the critical ordering fix. Device is now a pure thermostat with no children, ensuring HomeKit shows it as a climate card.
- **Removed sleep mode**: Sleep mode switch removed to eliminate child endpoints that could cause HomeKit to show wrong device type.
- **showExtras**: Now controls only fan speed control on the thermostat.

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
