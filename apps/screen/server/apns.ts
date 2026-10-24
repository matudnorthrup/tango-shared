import { connect } from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DeskDevice } from './desk/devices.js';

export interface APNsConfig { keyPath: string; keyId: string; teamId: string; bundleId: string }
export interface PushResult { status: number; reason?: string }
export interface PushSender { bundleId: string; send(device: DeskDevice, payload: object, collapseId: string): Promise<PushResult> }
export function apnsConfig(env: NodeJS.ProcessEnv): APNsConfig | null {
  const { TANGO_APNS_KEY_PATH: keyPath, TANGO_APNS_KEY_ID: keyId, TANGO_APNS_TEAM_ID: teamId, TANGO_APNS_BUNDLE_ID: bundleId } = env;
  return keyPath && keyId && teamId && bundleId ? { keyPath, keyId, teamId, bundleId } : null;
}
/** Keys are loaded only at runtime when configured. The JWT is renewed before Apple's one-hour limit. */
export class APNsSender implements PushSender {
  readonly bundleId: string;
  private jwt: { text: string; at: number } | null = null;
  constructor(private readonly config: APNsConfig, private readonly key: KeyObject = createPrivateKey(readFileSync(config.keyPath)),
    private readonly host: (d: DeskDevice) => string = d => `https://api${d.environment === 'sandbox' ? '.sandbox' : ''}.push.apple.com`) {
    this.bundleId = config.bundleId;
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('APNs requires an ES256 key');
  }
  private token(): string {
    const at = Math.floor(Date.now() / 1000);
    if (this.jwt && at - this.jwt.at < 3000) return this.jwt.text;
    const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const body = `${encode({ alg: 'ES256', kid: this.config.keyId })}.${encode({ iss: this.config.teamId, iat: at })}`;
    const signature = sign('sha256', Buffer.from(body), { key: this.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    this.jwt = { text: `${body}.${signature}`, at };
    return this.jwt.text;
  }
  async send(device: DeskDevice, payload: object, collapseId: string): Promise<PushResult> {
    if (device.bundleId !== this.bundleId) throw new Error('APNs bundle mismatch');
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 4096) throw new Error('APNs payload exceeds 4096 bytes');
    const authorization = `bearer ${this.token()}`;
    return new Promise((resolve, reject) => {
      const session = connect(this.host(device));
      const finish = (error?: Error, result?: PushResult) => {
        clearTimeout(timeout);
        session.destroy();
        if (error) reject(error); else resolve(result!);
      };
      const timeout = setTimeout(() => finish(new Error('APNs timed out')), 15_000);
      session.on('error', error => finish(error));
      const request = session.request({ ':method': 'POST', ':path': `/3/device/${device.token}`, authorization,
        'apns-topic': this.bundleId, 'apns-push-type': 'alert', 'apns-priority': '10',
        'apns-collapse-id': collapseId, 'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600) });
      let status = 0, data = '';
      request.on('response', headers => { status = Number(headers[':status']); });
      request.setEncoding('utf8');
      request.on('data', chunk => { data += chunk; });
      request.on('error', error => finish(error));
      request.on('end', () => {
        let reason: string | undefined;
        try { reason = JSON.parse(data).reason; } catch { /* success has no body */ }
        finish(undefined, { status, ...(reason ? { reason } : {}) });
      });
      request.end(body);
    });
  }
}
export function configuredAPNs(env: NodeJS.ProcessEnv, log: (event: string) => void): PushSender | null {
  const config = apnsConfig(env);
  if (!config) { log('desk.push.disabled: APNs configuration is incomplete'); return null; }
  try { return new APNsSender(config); }
  catch { log('desk.push.disabled: APNs key could not be loaded'); return null; }
}
