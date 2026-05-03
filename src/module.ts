/**
 * Matterbridge AC Freedom Plugin v2
 *
 * Exposes AUX air conditioners via Matter protocol.
 *
 * Device structure:
 * - Thermostat endpoint with FanControl cluster (single endpoint, no children)
 *   → HomeKit shows this as a climate card with fan speed control
 * - Sleep Mode as a separate bridged switch device (when showExtras is ON)
 *   → HomeKit shows this as a separate switch tile
 *
 * FanControl is an optional cluster on the Thermostat device type per Matter spec.
 * Adding it directly to the thermostat (not as a child fanDevice) ensures HomeKit
 * always categorizes the device as a thermostat/climate card.
 *
 * Supports both cloud (BroadLink SmartHomeCS) and local (Broadlink UDP) connections.
 */

import {
  Matterbridge,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformConfig,
  thermostatDevice,
  onOffSwitch,
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
  SLEEP: 'ac_slp',
};

const CLOUD_MODE = { AUTO: 4, COOL: 0, HEAT: 1, DRY: 2, FAN: 3 };
const FAN_SPEED = { AUTO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, TURBO: 4, MUTE: 5 };

// ── Config Interfaces ────────────────────────────────────────────

interface CloudDeviceConfig {
  name: string;
  email: string;
  password: string;
  region?: string;
  deviceId?: string;
  showExtras?: boolean;
}

interface LocalDeviceConfig {
  name: string;
  ip: string;
  mac: string;
  showExtras?: boolean;
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
  showExtras: boolean;
}

const TEMP_STEP = 1; // Fixed 1°C step

// ── Runtime State ────────────────────────────────────────────────

interface AcState {
  power: boolean;
  mode: number;
  targetTemp: number;
  currentTemp: number;
  fanSpeed: number;
  sleep: boolean;
}

interface ManagedDevice {
  config: DeviceConfig;
  api: AuxCloudAPI | BroadlinkAcApi;
  apiType: 'cloud' | 'local';
  cloudDevice?: CloudDevice;
  connected: boolean;
  state: AcState;
  thermostat: MatterbridgeEndpoint;
  sleepSwitch?: MatterbridgeEndpoint;
  pollTimer?: ReturnType<typeof setInterval>;
  tempDebounce?: ReturnType<typeof setTimeout>;
}

// ── Plugin ───────────────────────────────────────────────────────

export default function initializePlugin(matterbridge: Matterbridge, log: AnsiLogger, config: PlatformConfig): AcFreedomPlatform {
  return new AcFreedomPlatform(matterbridge, log, config);
}

export class AcFreedomPlatform extends MatterbridgeDynamicPlatform {
  private devices: ManagedDevice[] = [];

  constructor(matterbridge: Matterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);
    if (this.verifyMatterbridgeVersion === undefined || typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(`Requires Matterbridge >= 3.4.0. Current: ${this.matterbridge.matterbridgeVersion}`);
    }
    this.log.info('AC Freedom v2 initializing');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();
    await this.discoverDevices();
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure: subscribing and starting polls');
    for (const dev of this.devices) {
      await this.subscribe(dev);
      this.startPolling(dev);
    }
  }

  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`Log level: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown: ${reason ?? 'none'}`);
    for (const dev of this.devices) {
      if (dev.pollTimer) clearInterval(dev.pollTimer);
      if (dev.tempDebounce) clearTimeout(dev.tempDebounce);
    }
    this.devices = [];
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  // ── Discovery ──────────────────────────────────────────────────

  private async discoverDevices(): Promise<void> {
    const clouds = (this.config.cloudDevices as CloudDeviceConfig[]) || [];
    const locals = (this.config.localDevices as LocalDeviceConfig[]) || [];
    this.log.info(`Found ${clouds.length} cloud + ${locals.length} local device configs`);

    for (const c of clouds) {
      await this.addDevice({
        name: c.name,
        connection: 'cloud',
        cloudEmail: c.email,
        cloudPassword: c.password,
        cloudRegion: c.region,
        cloudDeviceId: c.deviceId,
        showExtras: c.showExtras === true,
      });
    }

    for (const l of locals) {
      await this.addDevice({
        name: l.name,
        connection: 'local',
        localIp: l.ip,
        localMac: l.mac,
        showExtras: l.showExtras === true,
      });
    }
  }

  private async addDevice(cfg: DeviceConfig): Promise<void> {
    this.log.info(`Adding ${cfg.connection} device: "${cfg.name}"`);

    // Create API instance
    let api: AuxCloudAPI | BroadlinkAcApi;
    let cloudDevice: CloudDevice | undefined;
    let connected = false;

    if (cfg.connection === 'cloud') {
      const cloudApi = new AuxCloudAPI(cfg.cloudRegion || 'eu');
      api = cloudApi;
      try {
        if (cfg.cloudEmail && cfg.cloudPassword) {
          await cloudApi.login(cfg.cloudEmail, cfg.cloudPassword);
          const families = await cloudApi.getFamilies();
          let devs: CloudDevice[] = [];
          for (const f of families) devs.push(...(await cloudApi.getDevices(f.familyid)));
          if (cfg.cloudDeviceId) devs = devs.filter(d => d.endpointId === cfg.cloudDeviceId);
          if (devs.length > 0) {
            cloudDevice = devs[0];
            connected = true;
            this.log.info(`Cloud connected: ${cloudDevice.friendlyName || cfg.name} (${cloudDevice.endpointId})`);
          } else {
            this.log.warn('Cloud: no devices found');
          }
        }
      } catch (err) {
        this.log.warn(`Cloud login failed: ${(err as Error).message}`);
      }
    } else {
      const localApi = new BroadlinkAcApi(cfg.localIp!, cfg.localMac!);
      api = localApi;
      try {
        connected = await localApi.connect();
        if (connected) this.log.info(`Local connected: ${cfg.localIp}`);
        else this.log.warn(`Local connection failed: ${cfg.localIp}`);
      } catch (err) {
        this.log.warn(`Local error: ${(err as Error).message}`);
      }
    }

    const serial = cfg.connection === 'cloud'
      ? (cloudDevice?.endpointId || `cloud-${cfg.cloudEmail}`)
      : (cfg.localMac || `local-${cfg.localIp}`);

    const state: AcState = {
      power: false,
      mode: CLOUD_MODE.AUTO,
      targetTemp: 24,
      currentTemp: 24,
      fanSpeed: FAN_SPEED.AUTO,
      sleep: false,
    };

    // ── Create thermostat endpoint (with FanControl) ──
    const thermostat = new MatterbridgeEndpoint(thermostatDevice, { uniqueStorageKey: `acf2-${serial}` });
    thermostat
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        cfg.name || 'AUX AC', serial,
        this.matterbridge.aggregatorVendorId,
        'AUX', 'AC Freedom', 10000, '2.0.0',
      )
      .createDefaultPowerSourceWiredClusterServer()
      .createDefaultThermostatClusterServer(
        state.currentTemp, state.targetTemp, state.targetTemp,
        0, 16, 32, 16, 32,
      );

    // Add FanControl cluster to thermostat BEFORE addRequiredClusterServers
    if (cfg.showExtras) {
      thermostat.createDefaultFanControlClusterServer(
        FanControl.FanMode.Auto,
        FanControl.FanModeSequence.OffLowMedHighAuto,
        0, 0,
      );
    }

    thermostat.addRequiredClusterServers();

    this.setSelectDevice(serial, cfg.name);
    const selected = this.validateDevice([cfg.name, serial]);
    if (selected) await this.registerDevice(thermostat);

    // ── Create separate sleep switch device (not a child) ──
    let sleepSwitch: MatterbridgeEndpoint | undefined;
    if (cfg.showExtras) {
      const sleepSerial = `${serial}-sleep`;
      sleepSwitch = new MatterbridgeEndpoint(onOffSwitch, { uniqueStorageKey: `acf2-${sleepSerial}` });
      sleepSwitch
        .createDefaultBridgedDeviceBasicInformationClusterServer(
          `${cfg.name} Sleep`, sleepSerial,
          this.matterbridge.aggregatorVendorId,
          'AUX', 'AC Freedom', 10001, '2.0.0',
        )
        .createOnOffClusterServer(false)
        .addRequiredClusterServers();

      this.setSelectDevice(sleepSerial, `${cfg.name} Sleep`);
      const sleepSelected = this.validateDevice([`${cfg.name} Sleep`, sleepSerial]);
      if (sleepSelected) await this.registerDevice(sleepSwitch);
    }

    const dev: ManagedDevice = {
      config: cfg,
      api,
      apiType: cfg.connection,
      cloudDevice,
      connected,
      state,
      thermostat,
      sleepSwitch,
    };

    this.devices.push(dev);
    this.log.info(`Device registered: "${cfg.name}" (connected=${connected}, extras=${cfg.showExtras})`);
  }

  // ── Subscribe (Matter → AC) ────────────────────────────────────

  private async subscribe(dev: ManagedDevice): Promise<void> {
    const { thermostat, sleepSwitch } = dev;

    // System mode
    await thermostat.subscribeAttribute('Thermostat', 'systemMode', (val: unknown) => {
      const mode = val as Thermostat.SystemMode;
      this.log.info(`systemMode → ${mode}`);
      if (mode === Thermostat.SystemMode.Off) {
        dev.state.power = false;
        this.sendPower(dev, false);
      } else {
        dev.state.power = true;
        const acMode = mode === Thermostat.SystemMode.Heat ? CLOUD_MODE.HEAT
          : mode === Thermostat.SystemMode.Cool ? CLOUD_MODE.COOL
          : CLOUD_MODE.AUTO;
        dev.state.mode = acMode;
        this.sendMode(dev, acMode);
      }
    });

    // Cooling setpoint (debounced)
    await thermostat.subscribeAttribute('Thermostat', 'occupiedCoolingSetpoint', (val: unknown) => {
      const temp = (val as number) / 100;
      const rounded = this.roundTemp(temp, TEMP_STEP);
      this.log.info(`coolSetpoint → ${temp}°C (rounded: ${rounded}°C)`);
      dev.state.targetTemp = rounded;
      this.debounceSendTemp(dev);
    });

    // Heating setpoint (debounced)
    await thermostat.subscribeAttribute('Thermostat', 'occupiedHeatingSetpoint', (val: unknown) => {
      const temp = (val as number) / 100;
      const rounded = this.roundTemp(temp, TEMP_STEP);
      this.log.info(`heatSetpoint → ${temp}°C (rounded: ${rounded}°C)`);
      dev.state.targetTemp = rounded;
      this.debounceSendTemp(dev);
    });

    // Fan control (on thermostat endpoint)
    if (dev.config.showExtras) {
      await thermostat.subscribeAttribute('FanControl', 'fanMode', (val: unknown) => {
        const speed = this.matterFanToAc(val as FanControl.FanMode);
        this.log.info(`fanMode → ${val} (speed: ${speed})`);
        dev.state.fanSpeed = speed;
        this.sendFanSpeed(dev, speed);
      });

      await thermostat.subscribeAttribute('FanControl', 'percentSetting', (val: unknown) => {
        const pct = (val as number | null) ?? 0;
        const speed = this.pctToFanSpeed(pct);
        this.log.info(`fanPercent → ${pct}% (speed: ${speed})`);
        dev.state.fanSpeed = speed;
        this.sendFanSpeed(dev, speed);
      });
    }

    // Sleep switch (separate device)
    if (sleepSwitch) {
      await sleepSwitch.subscribeAttribute('OnOff', 'onOff', (val: unknown) => {
        dev.state.sleep = val as boolean;
        this.log.info(`sleep → ${val}`);
        this.sendSleep(dev, val as boolean);
      });
    }
  }

  // ── Temperature Debounce ───────────────────────────────────────

  private roundTemp(temp: number, step: number): number {
    return Math.round(temp / step) * step;
  }

  private debounceSendTemp(dev: ManagedDevice): void {
    if (dev.tempDebounce) clearTimeout(dev.tempDebounce);
    dev.tempDebounce = setTimeout(() => {
      const t = dev.state.targetTemp;
      this.log.info(`Sending temp: ${t}°C`);
      this.sendTemp(dev, t);
      // Sync both setpoints to rounded value
      const v = Math.round(t * 100);
      dev.thermostat.updateAttribute('Thermostat', 'occupiedCoolingSetpoint', v, this.log).catch(() => {});
      dev.thermostat.updateAttribute('Thermostat', 'occupiedHeatingSetpoint', v, this.log).catch(() => {});
    }, 500);
  }

  // ── Polling (AC → Matter) ──────────────────────────────────────

  private startPolling(dev: ManagedDevice): void {
    dev.pollTimer = setInterval(() => this.poll(dev), 30_000);
    this.poll(dev);
  }

  private async poll(dev: ManagedDevice): Promise<void> {
    try {
      if (dev.apiType === 'cloud') {
        await this.pollCloud(dev);
      } else {
        await this.pollLocal(dev);
      }
      await this.pushToMatter(dev);
    } catch (err) {
      this.log.debug(`Poll error: ${(err as Error).message}`);
    }
  }

  private async pollCloud(dev: ManagedDevice): Promise<void> {
    const api = dev.api as AuxCloudAPI;
    if (!dev.cloudDevice) return;

    try {
      const p = await api.getDeviceParams(dev.cloudDevice);
      if (!p) return;
      dev.connected = true;
      dev.state.power = !!p[CLOUD.POWER];
      dev.state.mode = p[CLOUD.MODE] ?? CLOUD_MODE.AUTO;
      dev.state.targetTemp = (p[CLOUD.TEMP_TARGET] ?? 240) / 10;
      dev.state.currentTemp = (p[CLOUD.TEMP_AMBIENT] ?? 240) / 10;
      dev.state.fanSpeed = p[CLOUD.FAN_SPEED] ?? FAN_SPEED.AUTO;
      dev.state.sleep = !!p[CLOUD.SLEEP];
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('server busy')) return;
      if (msg.includes('token') && dev.config.cloudEmail && dev.config.cloudPassword) {
        try {
          await api.login(dev.config.cloudEmail, dev.config.cloudPassword);
        } catch { /* will retry next poll */ }
      }
    }
  }

  private async pollLocal(dev: ManagedDevice): Promise<void> {
    const api = dev.api as BroadlinkAcApi;
    try {
      const ok = await api.update();
      if (!ok) return;
      dev.connected = true;
      const s = api.state;
      dev.state.power = !!s.power;
      dev.state.targetTemp = s.temperature;
      dev.state.currentTemp = s.ambientTemp;
      dev.state.fanSpeed = s.fanSpeed;
      dev.state.sleep = !!s.sleep;
      const modeMap: Record<number, number> = { 1: CLOUD_MODE.COOL, 2: CLOUD_MODE.DRY, 4: CLOUD_MODE.HEAT, 6: CLOUD_MODE.FAN, 8: CLOUD_MODE.AUTO };
      dev.state.mode = modeMap[s.mode] ?? CLOUD_MODE.AUTO;
    } catch {
      // Will retry on next poll
    }
  }

  private async pushToMatter(dev: ManagedDevice): Promise<void> {
    const { thermostat, sleepSwitch, state } = dev;

    // System mode
    let sysMode: Thermostat.SystemMode;
    if (!state.power) {
      sysMode = Thermostat.SystemMode.Off;
    } else {
      switch (state.mode) {
        case CLOUD_MODE.HEAT: sysMode = Thermostat.SystemMode.Heat; break;
        case CLOUD_MODE.COOL: sysMode = Thermostat.SystemMode.Cool; break;
        default: sysMode = Thermostat.SystemMode.Auto; break;
      }
    }
    await thermostat.updateAttribute('Thermostat', 'systemMode', sysMode, this.log);

    // Running state
    await thermostat.updateAttribute('Thermostat', 'thermostatRunningState', {
      heat: state.power && state.mode === CLOUD_MODE.HEAT,
      cool: state.power && state.mode === CLOUD_MODE.COOL,
      fan: state.power,
      heatStage2: false, coolStage2: false, fanStage2: false, fanStage3: false,
    }, this.log);

    // Running mode
    let runMode = Thermostat.ThermostatRunningMode.Off;
    if (state.power) {
      if (state.mode === CLOUD_MODE.HEAT) runMode = Thermostat.ThermostatRunningMode.Heat;
      else if (state.mode === CLOUD_MODE.COOL) runMode = Thermostat.ThermostatRunningMode.Cool;
    }
    await thermostat.updateAttribute('Thermostat', 'thermostatRunningMode', runMode, this.log);

    // Temperatures
    await thermostat.updateAttribute('Thermostat', 'localTemperature', Math.round(state.currentTemp * 100), this.log);
    await thermostat.updateAttribute('Thermostat', 'occupiedCoolingSetpoint', Math.round(state.targetTemp * 100), this.log);
    await thermostat.updateAttribute('Thermostat', 'occupiedHeatingSetpoint', Math.round(state.targetTemp * 100), this.log);

    // Fan (on thermostat endpoint)
    if (dev.config.showExtras) {
      await thermostat.updateAttribute('FanControl', 'fanMode', this.acFanToMatter(state.fanSpeed), this.log);
      const pct = this.fanSpeedToPct(state.fanSpeed);
      await thermostat.updateAttribute('FanControl', 'percentSetting', pct, this.log);
      await thermostat.updateAttribute('FanControl', 'percentCurrent', pct, this.log);
    }

    // Sleep switch
    if (sleepSwitch) {
      await sleepSwitch.updateAttribute('OnOff', 'onOff', state.sleep, this.log);
    }
  }

  // ── Fan Speed Mapping ──────────────────────────────────────────

  private acFanToMatter(speed: number): FanControl.FanMode {
    switch (speed) {
      case FAN_SPEED.LOW: return FanControl.FanMode.Low;
      case FAN_SPEED.MEDIUM: return FanControl.FanMode.Medium;
      case FAN_SPEED.HIGH: case FAN_SPEED.TURBO: return FanControl.FanMode.High;
      case FAN_SPEED.MUTE: return FanControl.FanMode.Low;
      default: return FanControl.FanMode.Auto;
    }
  }

  private matterFanToAc(mode: FanControl.FanMode): number {
    switch (mode) {
      case FanControl.FanMode.Low: return FAN_SPEED.LOW;
      case FanControl.FanMode.Medium: return FAN_SPEED.MEDIUM;
      case FanControl.FanMode.High: return FAN_SPEED.HIGH;
      case FanControl.FanMode.Auto: return FAN_SPEED.AUTO;
      default: return FAN_SPEED.AUTO;
    }
  }

  private fanSpeedToPct(speed: number): number {
    const map: Record<number, number> = { 0: 0, 5: 20, 1: 40, 2: 60, 3: 80, 4: 100 };
    return map[speed] ?? 0;
  }

  private pctToFanSpeed(pct: number): number {
    if (pct <= 0) return FAN_SPEED.AUTO;
    if (pct <= 20) return FAN_SPEED.MUTE;
    if (pct <= 40) return FAN_SPEED.LOW;
    if (pct <= 60) return FAN_SPEED.MEDIUM;
    if (pct <= 80) return FAN_SPEED.HIGH;
    return FAN_SPEED.TURBO;
  }

  // ── Send Commands to AC ────────────────────────────────────────

  private sendPower(dev: ManagedDevice, on: boolean): void {
    if (!dev.connected) return;
    (dev.apiType === 'cloud'
      ? this.cloudSet(dev, { [CLOUD.POWER]: on ? 1 : 0 })
      : this.localSet(dev, s => { s.power = on ? 1 : 0; })
    ).catch(e => this.log.warn(`sendPower: ${e}`));
  }

  private sendMode(dev: ManagedDevice, mode: number): void {
    if (!dev.connected) return;
    if (dev.apiType === 'cloud') {
      this.cloudSet(dev, { [CLOUD.POWER]: 1, [CLOUD.MODE]: mode }).catch(e => this.log.warn(`sendMode: ${e}`));
    } else {
      const map: Record<number, number> = { [CLOUD_MODE.AUTO]: 8, [CLOUD_MODE.COOL]: 1, [CLOUD_MODE.HEAT]: 4, [CLOUD_MODE.DRY]: 2, [CLOUD_MODE.FAN]: 6 };
      this.localSet(dev, s => { s.power = 1; s.mode = map[mode] ?? 8; }).catch(e => this.log.warn(`sendMode: ${e}`));
    }
  }

  private sendTemp(dev: ManagedDevice, temp: number): void {
    if (!dev.connected) return;
    if (dev.apiType === 'cloud') {
      this.cloudSet(dev, { [CLOUD.TEMP_TARGET]: Math.round(temp * 10) }).catch(e => this.log.warn(`sendTemp: ${e}`));
    } else {
      this.localSet(dev, s => { s.temperature = temp; }).catch(e => this.log.warn(`sendTemp: ${e}`));
    }
  }

  private sendFanSpeed(dev: ManagedDevice, speed: number): void {
    if (!dev.connected) return;
    if (dev.apiType === 'cloud') {
      this.cloudSet(dev, { [CLOUD.FAN_SPEED]: speed }).catch(e => this.log.warn(`sendFan: ${e}`));
    } else {
      this.localSet(dev, s => {
        s.fanSpeed = speed;
        s.turbo = speed === FAN_SPEED.TURBO ? 1 : 0;
        s.mute = speed === FAN_SPEED.MUTE ? 1 : 0;
      }).catch(e => this.log.warn(`sendFan: ${e}`));
    }
  }

  private sendSleep(dev: ManagedDevice, on: boolean): void {
    if (!dev.connected) return;
    if (dev.apiType === 'cloud') {
      this.cloudSet(dev, { [CLOUD.SLEEP]: on ? 1 : 0 }).catch(e => this.log.warn(`sendSleep: ${e}`));
    } else {
      this.localSet(dev, s => { s.sleep = on ? 1 : 0; }).catch(e => this.log.warn(`sendSleep: ${e}`));
    }
  }

  private async cloudSet(dev: ManagedDevice, params: Record<string, number>): Promise<void> {
    if (!dev.cloudDevice) return;
    await (dev.api as AuxCloudAPI).setDeviceParams(dev.cloudDevice, params);
  }

  private async localSet(dev: ManagedDevice, mutate: (s: BroadlinkAcApi['state']) => void): Promise<void> {
    const api = dev.api as BroadlinkAcApi;
    mutate(api.state);
    await api.setState();
  }
}
