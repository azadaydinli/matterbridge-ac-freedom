/**
 * Broadlink AC local UDP API
 *
 * Handles UDP communication, AES encryption, authentication,
 * and state management for AUX AC units via Broadlink modules.
 */

import dgram from 'dgram';
import crypto from 'crypto';

// Constants
const DEFAULT_IV = Buffer.from([
  0x56, 0x2e, 0x17, 0x99, 0x6d, 0x09, 0x3d, 0x28,
  0xdd, 0xb3, 0xba, 0x69, 0x5a, 0x2e, 0x6f, 0x58,
]);

const DEFAULT_KEY = Buffer.from([
  0x09, 0x76, 0x28, 0x34, 0x3f, 0xe9, 0x9e, 0x23,
  0x76, 0x5c, 0x15, 0x13, 0xac, 0xcf, 0x8b, 0x02,
]);

const HEADER_MAGIC = Buffer.from([0x5a, 0xa5, 0xaa, 0x55, 0x5a, 0xa5, 0xaa, 0x55]);

const CMD_AUTH_REQUEST = 0x65;
const CMD_REQUEST = 0x6a;
const PORT_COMM = 80;

const STATE_QUERY = Buffer.from([
  0x0c, 0x00, 0xbb, 0x00, 0x06, 0x80, 0x00, 0x00,
  0x02, 0x00, 0x11, 0x01, 0x2b, 0x7e, 0x00, 0x00,
]);

const INFO_QUERY = Buffer.from([
  0x0c, 0x00, 0xbb, 0x00, 0x06, 0x80, 0x00, 0x00,
  0x02, 0x00, 0x21, 0x01, 0x1b, 0x7e, 0x00, 0x00,
]);

// Helpers
function checksum(data: Buffer): number {
  let cs = 0xbeaf;
  for (let i = 0; i < data.length; i++) {
    cs = (cs + data[i]) & 0xffff;
  }
  return cs;
}

function payloadChecksum(data: Buffer): number {
  let total = 0;
  for (let i = 0; i < data.length; i += 2) {
    if (i + 1 < data.length) {
      total += (data[i] << 8) | data[i + 1];
    } else {
      total += data[i] << 8;
    }
  }
  while (total >> 16) {
    total = (total & 0xffff) + (total >> 16);
  }
  return 0xffff ^ total;
}

function encrypt(data: Buffer, key: Buffer): Buffer {
  const padLen = (16 - (data.length % 16)) % 16;
  const padded = Buffer.concat([data, Buffer.alloc(padLen)]);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, DEFAULT_IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function decrypt(data: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, DEFAULT_IV);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function parseMac(macStr: string): Buffer {
  return Buffer.from(macStr.split(':').map(b => parseInt(b, 16)));
}

export class AcState {
  power = 0;
  mode = 0;
  temperature = 24;
  fanSpeed = 5; // Auto
  verticalFixation = 7;
  horizontalFixation = 7;
  mute = 0;
  turbo = 0;
  sleep = 0;
  health = 0;
  clean = 0;
  display = 1;
  mildew = 0;
  ambientTemp = 0;
}

export class BroadlinkAcApi {
  private _ip: string;
  private _mac: Buffer;
  private _key: Buffer;
  private _id: Buffer;
  private _count: number;
  private _authenticated: boolean;
  private _socket: dgram.Socket | null;
  state: AcState;

  constructor(ip: string, mac: string) {
    this._ip = ip;
    this._mac = parseMac(mac);
    this._key = Buffer.from(DEFAULT_KEY);
    this._id = Buffer.alloc(4);
    this._count = 0;
    this._authenticated = false;
    this._socket = null;
    this.state = new AcState();
  }

  // Connect & authenticate
  async connect(): Promise<boolean> {
    return new Promise((resolve) => {
      this._socket = dgram.createSocket('udp4');
      this._socket.on('error', () => resolve(false));
      this._socket.bind(0, () => {
        this._authenticate().then(resolve).catch(() => resolve(false));
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this._socket) {
      try { this._socket.close(); } catch { /* ignore */ }
      this._socket = null;
    }
    this._authenticated = false;
  }

  private async _authenticate(): Promise<boolean> {
    const payload = Buffer.alloc(0x50);
    for (let i = 0x04; i < 0x13; i++) payload[i] = 0x31;
    payload[0x1e] = 0x01;
    payload[0x2d] = 0x01;
    const name = Buffer.from('Test  1');
    name.copy(payload, 0x30);

    const result = await this._send(CMD_AUTH_REQUEST, payload);
    if (!result) return false;

    this._id = Buffer.from(result.subarray(0x00, 0x04));
    this._key = Buffer.from(result.subarray(0x04, 0x14));
    this._authenticated = true;
    return true;
  }

  // Send/receive UDP
  private _buildPacket(command: number, payload: Buffer): Buffer {
    const encrypted = encrypt(payload, this._key);
    const packet = Buffer.alloc(0x38 + encrypted.length);

    HEADER_MAGIC.copy(packet, 0);
    packet[0x24] = 0x2a;
    packet[0x25] = 0x27;
    packet[0x26] = command;

    this._count = (this._count + 1) & 0xffff;
    packet.writeUInt16LE(this._count, 0x28);
    this._mac.copy(packet, 0x2a);
    this._id.copy(packet, 0x30);

    const payloadCs = checksum(payload);
    packet.writeUInt16LE(payloadCs, 0x34);
    encrypted.copy(packet, 0x38);

    const fullCs = checksum(packet);
    packet.writeUInt16LE(fullCs, 0x20);

    return packet;
  }

  private _send(command: number, payload: Buffer): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      if (!this._socket) return reject(new Error('Not connected'));

      const packet = this._buildPacket(command, payload);
      const timeout = setTimeout(() => {
        this._socket?.removeListener('message', handler);
        resolve(null);
      }, 5000);

      const handler = (msg: Buffer) => {
        clearTimeout(timeout);
        this._socket?.removeListener('message', handler);
        if (msg.length <= 0x38) return resolve(null);
        const encrypted = msg.subarray(0x38);
        resolve(decrypt(encrypted, this._key));
      };

      this._socket.on('message', handler);
      this._socket.send(packet, 0, packet.length, PORT_COMM, this._ip, (err) => {
        if (err) {
          clearTimeout(timeout);
          this._socket?.removeListener('message', handler);
          resolve(null);
        }
      });
    });
  }

  // State operations
  async getState(): Promise<boolean> {
    if (!this._authenticated) return false;
    const result = await this._send(CMD_REQUEST, STATE_QUERY);
    if (!result) return false;
    this._parseState(result);
    return true;
  }

  async getInfo(): Promise<boolean> {
    if (!this._authenticated) return false;
    const result = await this._send(CMD_REQUEST, INFO_QUERY);
    if (!result) return false;
    this._parseInfo(result);
    return true;
  }

  async update(): Promise<boolean> {
    if (!this._authenticated) {
      const ok = await this._reauthenticate();
      if (!ok) return false;
    }
    try {
      const stateOk = await this.getState();
      if (stateOk) await this.getInfo();
      return stateOk;
    } catch {
      this._authenticated = false;
      return false;
    }
  }

  private async _reauthenticate(): Promise<boolean> {
    this._key = Buffer.from(DEFAULT_KEY);
    this._id = Buffer.alloc(4);
    this._count = 0;
    try {
      return await this._authenticate();
    } catch {
      return false;
    }
  }

  private _parseState(data: Buffer): void {
    if (data.length < 24) return;
    try {
      this.state.temperature = (data[12] >> 3) + 8;
      this.state.verticalFixation = data[12] & 0b00000111;
      this.state.horizontalFixation = data[13] & 0b00000111;
      this.state.fanSpeed = (data[15] >> 5) & 0b00000111;
      this.state.mute = (data[16] >> 7) & 1;
      this.state.turbo = (data[16] >> 6) & 1;
      this.state.mode = (data[17] >> 5) & 0b00001111;
      this.state.sleep = (data[17] >> 2) & 1;
      this.state.power = (data[20] >> 5) & 1;
      this.state.health = (data[20] >> 1) & 1;
      this.state.clean = (data[20] >> 2) & 1;
      this.state.display = (data[22] >> 4) & 1;
      this.state.mildew = (data[22] >> 3) & 1;

      if (data.length > 14 && ((data[14] >> 7) & 1)) {
        this.state.temperature += 0.5;
      }
    } catch { /* ignore parse errors */ }
  }

  private _parseInfo(data: Buffer): void {
    if (data.length < 34) return;
    try {
      let tempInt = data[17] & 0b00011111;
      if (data[17] > 63) tempInt += 32;
      const tempDec = data[33] / 10;
      this.state.ambientTemp = tempInt + tempDec;
    } catch { /* ignore parse errors */ }
  }

  async setState(): Promise<boolean> {
    if (!this._authenticated) {
      const ok = await this._reauthenticate();
      if (!ok) return false;
    }

    const cmd = this._buildSetStatePayload();
    const cs = payloadChecksum(cmd);
    const buf = Buffer.alloc(2 + cmd.length + 2);
    buf[0] = cmd.length + 2;
    buf[1] = 0x00;
    cmd.copy(buf, 2);
    buf[2 + cmd.length] = (cs >> 8) & 0xff;
    buf[2 + cmd.length + 1] = cs & 0xff;

    try {
      const result = await this._send(CMD_REQUEST, buf);
      return result !== null;
    } catch {
      this._authenticated = false;
      return false;
    }
  }

  private _buildSetStatePayload(): Buffer {
    const cmd = Buffer.alloc(23);
    cmd[0] = 0xbb;
    cmd[1] = 0x00;
    cmd[2] = 0x06;
    cmd[3] = 0x80;
    cmd[4] = 0x00;
    cmd[5] = 0x00;
    cmd[6] = 0x0f;
    cmd[7] = 0x00;
    cmd[8] = 0x01;
    cmd[9] = 0x01;

    const tempInt = Math.floor(this.state.temperature);
    const tempHalf = (this.state.temperature % 1) >= 0.5 ? 1 : 0;

    cmd[10] = ((tempInt - 8) << 3) | (this.state.verticalFixation & 0x07);
    cmd[11] = (this.state.horizontalFixation & 0x07) << 5;
    cmd[12] = (tempHalf << 7) | 0x0f;
    cmd[13] = (this.state.fanSpeed & 0x07) << 5;
    cmd[14] = ((this.state.mute & 1) << 7) | ((this.state.turbo & 1) << 6);
    cmd[15] = ((this.state.mode & 0x0f) << 5) | ((this.state.sleep & 1) << 2);
    cmd[16] = 0x00;
    cmd[17] = 0x00;
    cmd[18] = ((this.state.power & 1) << 5) | ((this.state.clean & 1) << 2) | ((this.state.health & 1) << 1);
    cmd[19] = 0x00;
    cmd[20] = ((this.state.display & 1) << 4) | ((this.state.mildew & 1) << 3);
    cmd[21] = 0x00;
    cmd[22] = 0x00;

    return cmd;
  }
}
