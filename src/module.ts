/**
 * Matterbridge AC Freedom Plugin
 *
 * Exposes AUX air conditioners as Matter thermostat devices (climate card).
 * FanControl cluster is optionally added to the thermostat endpoint itself
 * (not as a child device) so HomeKit always shows a climate card.
 *
 * Supports both cloud and local (Broadlink UDP) connections.
 */

import {
  Matterbridge,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformConfig,
  thermostatDevice,
} from 'matterbridge';
import { Thermostat, FanControl } from 'matterbridge/matter/clusters';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { AuxCloudAPI, CloudDevice } from './cloud-api.js';
import { BroadlinkAcApi } from './broadlink-api.js';

// Cloud API param keys
const CLOUD = {
  POWER: 'pwr',
  MODE: 'ac_mode',
  TEMP_TARGET: 'temp',
  TEMP_AMBIENT: 'envtemp',
  FAN_SPEED: 'ac_mark',
  SWING_V: 'ac_vdir',
  SWING_H: 'ac_hdir',
};

// Cloud mode values: 0=COOL, 1=HEAT, 2=DRY, 3=FAN, 4=AUTO
const CLOUD_MODE = { AUTO: 4, COOL: 0, HEAT: 1, DRY: 2, FAN: 3 };

// Fan speed values
const FAN_SPEED = { AUTO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, TURBO: 4, MUTE: 5 };

interface CloudDeviceConfig {
  name: string;
  email: string;
  password: string;
  region?: string;
  deviceId?: string;
  showExtras?: boolean;
  tempStep?: number;
}

interface LocalDeviceConfig {
  name: string;
  ip: string;
  mac: string;
  showExtras?: boolean;
  tempStep?: number;
}

interface DeviceConfig {
  name: string;
  connection: 'cloud' | 'local';
  cloudEmail?: string;
  cloudPassword?: string;
  cloudRegion?: string;
  cloudDeviceId?: string;
  localIp?: string;
  localMac?: string;
  showExtras?: boolean;
  tempStep?: number;
}

interface DeviceApi {
  type: 'cloud' | 'local';
  api: AuxCloudAPI | BroadlinkAcApi;
  device?: CloudDevice;
}

interface AcState {
  power: boolean;
  mode: number;
  targetTemp: number;
  currentTemp: number;
  fanSpeed: number;
  swingV: boolean;
  swingH: boolean;
}

interface ManagedDevice {
  config: DeviceConfig;
  deviceApi: DeviceApi;
  state: AcState;
  thermostat: MatterbridgeEndpoint;
  hasFan: boolean;
  pollTimer?: ReturnType<typeof setInterval>;
}

export default function initializePlugin(matterbridge: Matterbridge, log: AnsiLogger, config: PlatformConfig): AcFreedomPlatform {
  return new AcFreedomPlatform(matterbridge, log, config);
}

export class AcFreedomPlatform extends MatterbridgeDynamicPlatform {
  private managedDevices: ManagedDevice[] = [];

  constructor(matterbridge: Matterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (this.verifyMatterbridgeVersion === undefined || typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }

    this.log.info('Initializing AC Freedom platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();
    await this.discoverDevices();
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    for (const managed of this.managedDevices) {
      await this.subscribeDeviceAttributes(managed);
      this.startPolling(managed);
    }
  }

  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`Log level changed to: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);

    for (const managed of this.managedDevices) {
      if (managed.pollTimer) clearInterval(managed.pollTimer);
    }
    this.managedDevices = [];

    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  // ── Device Discovery ───────────────────────────────────────────

  private async discoverDevices(): Promise<void> {
    const cloudDevices = (this.config.cloudDevices as CloudDeviceConfig[]) || [];
    for (const cd of cloudDevices) {
      const unified: DeviceConfig = {
        name: cd.name,
        connection: 'cloud',
        cloudEmail: cd.email,
        cloudPassword: cd.password,
        cloudRegion: cd.region,
        cloudDeviceId: cd.deviceId,
        showExtras: cd.showExtras,
        tempStep: cd.tempStep,
      };
      try {
        await this.setupDevice(unified);
      } catch (err) {
        this.log.error(`Failed to setup cloud device ${cd.name}: ${(err as Error).message}`);
      }
    }

    const localDevices = (this.config.localDevices as LocalDeviceConfig[]) || [];
    for (const ld of localDevices) {
      const unified: DeviceConfig = {
        name: ld.name,
        connection: 'local',
        localIp: ld.ip,
        localMac: ld.mac,
        showExtras: ld.showExtras,
        tempStep: ld.tempStep,
      };
      try {
        await this.setupDevice(unified);
      } catch (err) {
        this.log.error(`Failed to setup local device ${ld.name}: ${(err as Error).message}`);
      }
    }
  }

  private async setupDevice(deviceConfig: DeviceConfig): Promise<void> {
    let deviceApi: DeviceApi | null = null;

    if (deviceConfig.connection === 'cloud') {
      deviceApi = await this.setupCloudDevice(deviceConfig);
    } else {
      deviceApi = await this.setupLocalDevice(deviceConfig);
    }

    if (!deviceApi) return;

    const state: AcState = {
      power: false,
      mode: CLOUD_MODE.AUTO,
      targetTemp: 24,
      currentTemp: 24,
      fanSpeed: FAN_SPEED.AUTO,
      swingV: false,
      swingH: false,
    };

    const managed: ManagedDevice = {
      config: deviceConfig,
      deviceApi,
      state,
      thermostat: undefined!,
      hasFan: false,
    };

    await this.createDevice(managed);
    this.managedDevices.push(managed);
  }

  private async setupCloudDevice(config: DeviceConfig): Promise<DeviceApi | null> {
    if (!config.cloudEmail || !config.cloudPassword) {
      this.log.error('Cloud config missing email/password');
      return null;
    }

    const api = new AuxCloudAPI(config.cloudRegion || 'eu');
    try {
      await api.login(config.cloudEmail, config.cloudPassword);
      this.log.info(`Cloud login successful: ${config.cloudEmail}`);

      const families = await api.getFamilies();
      let devices: CloudDevice[] = [];
      for (const fam of families) {
        const devs = await api.getDevices(fam.familyid);
        devices.push(...devs);
      }

      if (config.cloudDeviceId) {
        devices = devices.filter(d => d.endpointId === config.cloudDeviceId);
      }

      if (devices.length === 0) {
        this.log.error('No cloud devices found');
        return null;
      }

      const device = devices[0];
      this.log.info(`Cloud device: ${device.friendlyName || 'AUX AC'} (${device.endpointId})`);
      return { type: 'cloud', api, device };
    } catch (err) {
      this.log.error(`Cloud login failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async setupLocalDevice(config: DeviceConfig): Promise<DeviceApi | null> {
    if (!config.localIp || !config.localMac) {
      this.log.error('Local config missing ip/mac');
      return null;
    }

    const api = new BroadlinkAcApi(config.localIp, config.localMac);
    try {
      const connected = await api.connect();
      if (!connected) {
        this.log.error(`Failed to connect to local device at ${config.localIp}`);
        return null;
      }
      this.log.info(`Local device connected: ${config.localIp}`);
      return { type: 'local', api };
    } catch (err) {
      this.log.error(`Local connection failed: ${(err as Error).message}`);
      return null;
    }
  }

  // ── Device Creation ────────────────────────────────────────────

  private async createDevice(managed: ManagedDevice): Promise<void> {
    const name = managed.config.name || 'AUX AC';
    const serialNumber = managed.deviceApi.type === 'cloud'
      ? (managed.deviceApi.device?.endpointId || 'cloud-ac')
      : (managed.config.localMac || 'local-ac');

    // Thermostat endpoint — no child devices
    const thermostat = new MatterbridgeEndpoint(thermostatDevice, { uniqueStorageKey: `ac-${serialNumber}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        name,
        serialNumber,
        this.matterbridge.aggregatorVendorId,
        'AUX',
        'AC Freedom',
        10000,
        '1.0.0',
      )
      .createDefaultPowerSourceWiredClusterServer()
      .createDefaultThermostatClusterServer(
        managed.state.currentTemp,
        managed.state.targetTemp,
        managed.state.targetTemp,
        0,
        16,
        32,
        16,
        32,
      );

    // Add FanControl cluster to thermostat BEFORE addRequiredClusterServers
    if (managed.config.showExtras === true) {
      thermostat.createDefaultFanControlClusterServer(
        FanControl.FanMode.Auto,
        FanControl.FanModeSequence.OffLowMedHighAuto,
        0,
        0,
      );
      managed.hasFan = true;
    }

    // Finalize
    thermostat.addRequiredClusterServers();

    this.setSelectDevice(serialNumber, name);
    const selected = this.validateDevice([name, serialNumber]);
    if (selected) await this.registerDevice(thermostat);

    managed.thermostat = thermostat;
  }

  // ── Attribute Subscriptions (Matter → Device) ──────────────────

  private async subscribeDeviceAttributes(managed: ManagedDevice): Promise<void> {
    const { thermostat } = managed;

    // Thermostat: systemMode
    await thermostat.subscribeAttribute(
      'Thermostat',
      'systemMode',
      (newValue: unknown, _oldValue: unknown) => {
        this.log.info(`Thermostat systemMode changed to: ${newValue}`);
        const mode = newValue as Thermostat.SystemMode;
        if (mode === Thermostat.SystemMode.Off) {
          managed.state.power = false;
          this.sendPower(managed, false).catch(e => this.log.warn(`sendPower failed: ${e}`));
        } else {
          managed.state.power = true;
          let acMode: number;
          switch (mode) {
            case Thermostat.SystemMode.Heat: acMode = CLOUD_MODE.HEAT; break;
            case Thermostat.SystemMode.Cool: acMode = CLOUD_MODE.COOL; break;
            default: acMode = CLOUD_MODE.AUTO; break;
          }
          managed.state.mode = acMode;
          this.sendMode(managed, acMode).catch(e => this.log.warn(`sendMode failed: ${e}`));
        }
      },
    );

    // Thermostat: occupiedCoolingSetpoint
    await thermostat.subscribeAttribute(
      'Thermostat',
      'occupiedCoolingSetpoint',
      (newValue: unknown) => {
        const temp = (newValue as number) / 100;
        this.log.info(`Cooling setpoint changed to: ${temp}°C`);
        managed.state.targetTemp = temp;
        this.sendTemperature(managed, temp).catch(e => this.log.warn(`sendTemperature failed: ${e}`));
      },
    );

    // Thermostat: occupiedHeatingSetpoint
    await thermostat.subscribeAttribute(
      'Thermostat',
      'occupiedHeatingSetpoint',
      (newValue: unknown) => {
        const temp = (newValue as number) / 100;
        this.log.info(`Heating setpoint changed to: ${temp}°C`);
        managed.state.targetTemp = temp;
        this.sendTemperature(managed, temp).catch(e => this.log.warn(`sendTemperature failed: ${e}`));
      },
    );

    // FanControl on thermostat endpoint
    if (managed.hasFan) {
      await thermostat.subscribeAttribute(
        'FanControl',
        'fanMode',
        (newValue: unknown) => {
          this.log.info(`Fan mode changed to: ${newValue}`);
          const fanMode = newValue as FanControl.FanMode;
          const speed = this.matterFanModeToAcFanSpeed(fanMode);
          managed.state.fanSpeed = speed;
          this.sendFanSpeed(managed, speed).catch(e => this.log.warn(`sendFanSpeed failed: ${e}`));
        },
      );

      await thermostat.subscribeAttribute(
        'FanControl',
        'percentSetting',
        (newValue: unknown) => {
          const percent = (newValue as number | null) ?? 0;
          this.log.info(`Fan percent changed to: ${percent}%`);
          const speed = this.percentToFanSpeed(percent);
          managed.state.fanSpeed = speed;
          this.sendFanSpeed(managed, speed).catch(e => this.log.warn(`sendFanSpeed failed: ${e}`));
        },
      );
    }
  }

  // ── Polling (Device → Matter) ──────────────────────────────────

  private startPolling(managed: ManagedDevice): void {
    const interval = 30 * 1000;
    managed.pollTimer = setInterval(() => this.pollState(managed), interval);
    this.pollState(managed);
  }

  private async pollState(managed: ManagedDevice): Promise<void> {
    try {
      if (managed.deviceApi.type === 'cloud') {
        await this.pollCloud(managed);
      } else {
        await this.pollLocal(managed);
      }
      await this.updateMatterAttributes(managed);
    } catch (err) {
      this.log.warn(`Poll failed: ${(err as Error).message}`);
    }
  }

  private async pollCloud(managed: ManagedDevice): Promise<void> {
    const { api, device } = managed.deviceApi as { api: AuxCloudAPI; device: CloudDevice };
    try {
      const params = await api.getDeviceParams(device);
      if (!params) return;

      managed.state.power = !!params[CLOUD.POWER];
      managed.state.mode = params[CLOUD.MODE] ?? CLOUD_MODE.AUTO;
      managed.state.targetTemp = (params[CLOUD.TEMP_TARGET] ?? 240) / 10;
      managed.state.currentTemp = (params[CLOUD.TEMP_AMBIENT] ?? 240) / 10;
      managed.state.fanSpeed = params[CLOUD.FAN_SPEED] ?? FAN_SPEED.AUTO;
      managed.state.swingV = !!params[CLOUD.SWING_V];
      managed.state.swingH = !!params[CLOUD.SWING_H];
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('server busy')) return;
      if (msg.includes('token')) {
        await api.login(managed.config.cloudEmail!, managed.config.cloudPassword!);
      }
      throw err;
    }
  }

  private async pollLocal(managed: ManagedDevice): Promise<void> {
    const api = managed.deviceApi.api as BroadlinkAcApi;
    const ok = await api.update();
    if (!ok) return;

    const s = api.state;
    managed.state.power = !!s.power;
    managed.state.targetTemp = s.temperature;
    managed.state.currentTemp = s.ambientTemp;
    managed.state.fanSpeed = s.fanSpeed;
    managed.state.swingV = s.verticalFixation === 7;
    managed.state.swingH = s.horizontalFixation === 7;

    const modeMap: Record<number, number> = { 1: CLOUD_MODE.COOL, 2: CLOUD_MODE.DRY, 4: CLOUD_MODE.HEAT, 6: CLOUD_MODE.FAN, 8: CLOUD_MODE.AUTO };
    managed.state.mode = modeMap[s.mode] ?? CLOUD_MODE.AUTO;
  }

  private async updateMatterAttributes(managed: ManagedDevice): Promise<void> {
    const { thermostat, state } = managed;

    // Thermostat systemMode
    let systemMode: Thermostat.SystemMode;
    if (!state.power) {
      systemMode = Thermostat.SystemMode.Off;
    } else {
      switch (state.mode) {
        case CLOUD_MODE.HEAT: systemMode = Thermostat.SystemMode.Heat; break;
        case CLOUD_MODE.COOL: systemMode = Thermostat.SystemMode.Cool; break;
        default: systemMode = Thermostat.SystemMode.Auto; break;
      }
    }
    await thermostat.updateAttribute('Thermostat', 'systemMode', systemMode, this.log);

    // Running state
    const isHeating = state.power && state.mode === CLOUD_MODE.HEAT;
    const isCooling = state.power && state.mode === CLOUD_MODE.COOL;
    await thermostat.updateAttribute('Thermostat', 'thermostatRunningState', {
      heat: isHeating,
      cool: isCooling,
      fan: state.power,
      heatStage2: false,
      coolStage2: false,
      fanStage2: false,
      fanStage3: false,
    }, this.log);

    // Running mode
    let runningMode = Thermostat.ThermostatRunningMode.Off;
    if (state.power) {
      switch (state.mode) {
        case CLOUD_MODE.HEAT: runningMode = Thermostat.ThermostatRunningMode.Heat; break;
        case CLOUD_MODE.COOL: runningMode = Thermostat.ThermostatRunningMode.Cool; break;
        default: runningMode = Thermostat.ThermostatRunningMode.Off; break;
      }
    }
    await thermostat.updateAttribute('Thermostat', 'thermostatRunningMode', runningMode, this.log);

    // Temperatures (Matter uses hundredths of a degree)
    await thermostat.updateAttribute('Thermostat', 'localTemperature', Math.round(state.currentTemp * 100), this.log);
    await thermostat.updateAttribute('Thermostat', 'occupiedCoolingSetpoint', Math.round(state.targetTemp * 100), this.log);
    await thermostat.updateAttribute('Thermostat', 'occupiedHeatingSetpoint', Math.round(state.targetTemp * 100), this.log);

    // FanControl on thermostat endpoint
    if (managed.hasFan) {
      const fanMode = this.acFanSpeedToMatterFanMode(state.fanSpeed);
      const percent = this.fanSpeedToPercent(state.fanSpeed);
      await thermostat.updateAttribute('FanControl', 'fanMode', fanMode, this.log);
      await thermostat.updateAttribute('FanControl', 'percentSetting', percent, this.log);
      await thermostat.updateAttribute('FanControl', 'percentCurrent', percent, this.log);
    }
  }

  // ── Fan Speed Mapping ──────────────────────────────────────────

  private acFanSpeedToMatterFanMode(speed: number): FanControl.FanMode {
    switch (speed) {
      case FAN_SPEED.LOW: return FanControl.FanMode.Low;
      case FAN_SPEED.MEDIUM: return FanControl.FanMode.Medium;
      case FAN_SPEED.HIGH: return FanControl.FanMode.High;
      case FAN_SPEED.TURBO: return FanControl.FanMode.High;
      case FAN_SPEED.MUTE: return FanControl.FanMode.Low;
      default: return FanControl.FanMode.Auto;
    }
  }

  private matterFanModeToAcFanSpeed(mode: FanControl.FanMode): number {
    switch (mode) {
      case FanControl.FanMode.Low: return FAN_SPEED.LOW;
      case FanControl.FanMode.Medium: return FAN_SPEED.MEDIUM;
      case FanControl.FanMode.High: return FAN_SPEED.HIGH;
      case FanControl.FanMode.Auto: return FAN_SPEED.AUTO;
      default: return FAN_SPEED.AUTO;
    }
  }

  private fanSpeedToPercent(speed: number): number {
    const map: Record<number, number> = { 0: 0, 5: 20, 1: 40, 2: 60, 3: 80, 4: 100 };
    return map[speed] ?? 0;
  }

  private percentToFanSpeed(pct: number): number {
    if (pct <= 0) return FAN_SPEED.AUTO;
    if (pct <= 20) return FAN_SPEED.MUTE;
    if (pct <= 40) return FAN_SPEED.LOW;
    if (pct <= 60) return FAN_SPEED.MEDIUM;
    if (pct <= 80) return FAN_SPEED.HIGH;
    return FAN_SPEED.TURBO;
  }

  // ── Send Commands to Device ────────────────────────────────────

  private async sendPower(managed: ManagedDevice, on: boolean): Promise<void> {
    if (managed.deviceApi.type === 'cloud') {
      await this.cloudSet(managed, { [CLOUD.POWER]: on ? 1 : 0 });
    } else {
      const api = managed.deviceApi.api as BroadlinkAcApi;
      api.state.power = on ? 1 : 0;
      await api.setState();
    }
  }

  private async sendMode(managed: ManagedDevice, mode: number): Promise<void> {
    if (managed.deviceApi.type === 'cloud') {
      await this.cloudSet(managed, { [CLOUD.POWER]: 1, [CLOUD.MODE]: mode });
    } else {
      const localModeMap: Record<number, number> = {
        [CLOUD_MODE.AUTO]: 8, [CLOUD_MODE.COOL]: 1,
        [CLOUD_MODE.HEAT]: 4, [CLOUD_MODE.DRY]: 2, [CLOUD_MODE.FAN]: 6,
      };
      const api = managed.deviceApi.api as BroadlinkAcApi;
      api.state.power = 1;
      api.state.mode = localModeMap[mode] ?? 8;
      await api.setState();
    }
  }

  private async sendTemperature(managed: ManagedDevice, temp: number): Promise<void> {
    if (managed.deviceApi.type === 'cloud') {
      await this.cloudSet(managed, { [CLOUD.TEMP_TARGET]: Math.round(temp * 10) });
    } else {
      const api = managed.deviceApi.api as BroadlinkAcApi;
      api.state.temperature = temp;
      await api.setState();
    }
  }

  private async sendFanSpeed(managed: ManagedDevice, speed: number): Promise<void> {
    if (managed.deviceApi.type === 'cloud') {
      await this.cloudSet(managed, { [CLOUD.FAN_SPEED]: speed });
    } else {
      const api = managed.deviceApi.api as BroadlinkAcApi;
      api.state.fanSpeed = speed;
      api.state.turbo = speed === FAN_SPEED.TURBO ? 1 : 0;
      api.state.mute = speed === FAN_SPEED.MUTE ? 1 : 0;
      await api.setState();
    }
  }

  private async cloudSet(managed: ManagedDevice, params: Record<string, number>): Promise<void> {
    const { api, device } = managed.deviceApi as { api: AuxCloudAPI; device: CloudDevice };
    await api.setDeviceParams(device, params);
  }
}
