# matterbridge-ac-freedom

[![npm](https://img.shields.io/npm/v/matterbridge-ac-freedom)](https://www.npmjs.com/package/matterbridge-ac-freedom)
[![license](https://img.shields.io/npm/l/matterbridge-ac-freedom)](https://github.com/azadaydinli/matterbridge-ac-freedom/blob/main/LICENSE)

A [Matterbridge](https://github.com/Luligu/matterbridge) plugin that exposes **AUX air conditioners** as Matter devices. Control your AUX AC from Apple Home, Google Home, Amazon Alexa, Samsung SmartThings, or any Matter-compatible platform.

Supports both **Cloud** (BroadLink SmartHomeCS) and **Local** (Broadlink UDP) connections.

## Features

All services appear as a single composed device (not separate tiles):

| Service | Matter Device Type | Description |
|---|---|---|
| **Thermostat** | `thermostatDevice` | Heat / Cool / Auto mode, target & current temperature |
| **Fan** | `fanDevice` (child) | Fan speed: Auto, Mute, Low, Medium, High, Turbo |
| **Sleep Mode** | `onOffSwitch` (child) | Sleep preset switch |
| **Health** | `onOffSwitch` (child) | Health / Ionizer preset switch |
| **Eco** | `onOffSwitch` (child) | Eco / Mildew prevention preset switch |
| **Clean** | `onOffSwitch` (child) | Self-clean preset switch |
| **Comfortable Wind** | `onOffSwitch` (child) | Comfortable wind mode switch |
| **Display** | `onOffSwitch` (child) | LED display on/off switch |

Preset switches are mutually exclusive — enabling one automatically disables the others.

## Installation

### From Matterbridge Frontend (recommended)

1. Open the Matterbridge frontend (`http://<your-ip>:8283`)
2. Go to **Plugins** → **Install**
3. Enter `matterbridge-ac-freedom` → **Install**
4. Configure your device(s) in the plugin config
5. Restart Matterbridge

### From CLI

```bash
matterbridge -add matterbridge-ac-freedom
```

## Configuration

### Cloud Connection

| Field | Description |
|---|---|
| `cloudEmail` | AUX / BroadLink cloud account email |
| `cloudPassword` | AUX / BroadLink cloud account password |
| `cloudRegion` | Server region: `eu`, `usa`, `cn`, `rus` (default: `eu`) |
| `cloudDeviceId` | Specific device endpoint ID (leave empty to auto-detect) |

### Local Connection

| Field | Description |
|---|---|
| `localIp` | Local IP address of the Broadlink module |
| `localMac` | MAC address (format: `AA:BB:CC:DD:EE:FF`) |

### Example Config

```json
{
  "name": "matterbridge-ac-freedom",
  "type": "DynamicPlatform",
  "devices": [
    {
      "name": "Living Room AC",
      "connection": "cloud",
      "cloudEmail": "user@example.com",
      "cloudPassword": "password",
      "cloudRegion": "eu",
      "showFan": true,
      "showDisplay": true,
      "showComfWind": true,
      "presetSleep": true,
      "presetHealth": true,
      "presetEco": true,
      "presetClean": true,
      "tempStep": 0.5
    }
  ]
}
```

### Optional Switches

All optional switches default to `true`. Set to `false` to hide:

- `showFan` — Fan speed control
- `showDisplay` — LED display toggle
- `showComfWind` — Comfortable wind mode
- `presetSleep` — Sleep mode
- `presetHealth` — Health / Ionizer
- `presetEco` — Eco / Mildew prevention
- `presetClean` — Self-clean

## Requirements

- [Matterbridge](https://github.com/Luligu/matterbridge) >= 3.4.0
- Node.js >= 20.0.0
- An AUX air conditioner with a Broadlink Wi-Fi module

## Related

- [homebridge-ac-freedom](https://github.com/azadaydinli/homebridge-ac-freedom) — The same plugin for Homebridge (HomeKit only)

## License

Apache-2.0
