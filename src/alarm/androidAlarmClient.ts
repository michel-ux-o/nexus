import {
  ALARM_BRIDGE_VERSION, ALARM_CHANNEL, encodeAlarmRequest, isRecord, parseAlarmMessage,
  readAlarmCapabilities, readMorningRequest,
  type AlarmMethod, type AndroidAlarmCapabilities, type AndroidMorningRequest,
} from './protocol';

export type AndroidAlarmSnapshot =
  | { status: 'unavailable' | 'connecting'; error: null }
  | { status: 'ready'; error: null; capabilities: AndroidAlarmCapabilities }
  | { status: 'error'; error: string };

export interface AlarmPort {
  onmessage: ((event: MessageEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: string): void;
  start(): void;
  close(): void;
}

export interface AlarmWindow {
  location: Pick<Location, 'origin' | 'protocol'>;
  self: unknown;
  top: unknown;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/**
 * Android postWebMessage has empty source origin and no source window. A frame's
 * normal postMessage always has a source window; a synthetic event is untrusted.
 * Native separately restricts the target to the exact hosted HTTPS origin.
 */
export function readAndroidAlarmHandshake(event: MessageEvent, host: AlarmWindow): AlarmPort | null {
  if (host.self !== host.top || host.location.protocol !== 'https:' ||
    !event.isTrusted || event.origin !== '' || event.source !== null || event.ports.length !== 1) return null;
  const message = parseAlarmMessage(event.data);
  if (message?.channel !== ALARM_CHANNEL || message.version !== ALARM_BRIDGE_VERSION ||
    message.type !== 'connect' || message.origin !== host.location.origin) return null;
  return event.ports[0];
}

interface WaitingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AndroidAlarmClient {
  private snapshot: AndroidAlarmSnapshot = { status: 'unavailable', error: null };
  private listeners = new Set<() => void>();
  private morningListeners = new Set<() => void>();
  private pending = new Map<string, WaitingRequest>();
  private port: AlarmPort | null = null;
  private started = false;
  private counter = 0;

  constructor(private host?: AlarmWindow, private timeoutMs = 8_000) {}

  getSnapshot = (): AndroidAlarmSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  subscribeMorningRequest = (listener: () => void): (() => void) => {
    this.morningListeners.add(listener);
    return () => { this.morningListeners.delete(listener); };
  };

  start(): void {
    if (!this.host || this.started) return;
    this.started = true;
    this.host.addEventListener('message', this.onHandshake);
  }

  dispose(): void {
    this.host?.removeEventListener('message', this.onHandshake);
    this.started = false;
    this.disconnect('Die Verbindung zur Android-App wurde beendet.');
    this.setSnapshot({ status: 'unavailable', error: null });
  }

  async openAlarmSettings(): Promise<void> {
    const result = await this.request('openAlarmSettings');
    if (!isRecord(result) || result.opened !== true) throw new Error('Die Weckereinstellungen konnten nicht geöffnet werden.');
  }

  /** Read-only: native retains this request until acknowledgeMorningRequest. */
  async consumeMorningRequest(): Promise<AndroidMorningRequest | null> {
    return readMorningRequest(await this.request('consumeMorningRequest'));
  }

  async acknowledgeMorningRequest(requestId: string): Promise<boolean> {
    const result = await this.request('acknowledgeMorningRequest', { requestId });
    if (!isRecord(result) || typeof result.acknowledged !== 'boolean') {
      throw new Error('Der Morgenstart konnte nicht bestätigt werden.');
    }
    return result.acknowledged;
  }

  private setSnapshot(snapshot: AndroidAlarmSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach(listener => listener());
  }

  private onHandshake = (event: MessageEvent): void => {
    if (!this.host) return;
    const port = readAndroidAlarmHandshake(event, this.host);
    if (!port) return;
    this.disconnect('Die Android-Verbindung wurde erneuert.');
    this.port = port;
    port.onmessage = this.onPortMessage;
    port.onmessageerror = () => this.failConnection('Die Nachricht der Android-App konnte nicht gelesen werden.');
    port.start();
    this.setSnapshot({ status: 'connecting', error: null });
    void this.request('getCapabilities').then(result => {
      if (this.port !== port) return;
      const capabilities = readAlarmCapabilities(result, this.host!.location.origin);
      if (!capabilities) throw new Error('Die Android-Weckerfunktion konnte nicht bestätigt werden.');
      this.setSnapshot({ status: 'ready', error: null, capabilities });
    }).catch(error => {
      if (this.port === port) this.failConnection(error instanceof Error ? error.message : 'Die Android-Verbindung ist fehlgeschlagen.');
    });
  };

  private onPortMessage = (event: MessageEvent): void => {
    const message = parseAlarmMessage(event.data);
    if (!message) return;
    if (message.channel === ALARM_CHANNEL && message.version === ALARM_BRIDGE_VERSION && message.type === 'morning-pending') {
      if (this.snapshot.status === 'ready') this.morningListeners.forEach(listener => listener());
      return;
    }
    if (typeof message.id !== 'string') return;
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.ok === true && Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')) waiting.resolve(message.result);
    else if (message.ok === false && isRecord(message.error) && typeof message.error.code === 'string' && typeof message.error.message === 'string') {
      // Do not expose arbitrary native detail or raw data in the web interface.
      waiting.reject(new Error('Die Android-App konnte die Weckeranfrage nicht ausführen. Bitte erneut versuchen.'));
    } else waiting.reject(new Error('Die Android-App hat eine ungültige Antwort gesendet.'));
  };

  private request(method: AlarmMethod, params?: { requestId: string }): Promise<unknown> {
    const id = `web-${Date.now()}-${++this.counter}`;
    let message: string;
    try { message = encodeAlarmRequest(id, method, params); }
    catch (error) { return Promise.reject(error); }
    const port = this.port;
    if (!port || (method !== 'getCapabilities' && this.snapshot.status !== 'ready')) {
      return Promise.reject(new Error('Der native Wecker ist nur in der verbundenen Android-Version verfügbar.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Die Android-App antwortet nicht. Bitte erneut versuchen.'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { port.postMessage(message); }
      catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Die Nachricht konnte nicht an die Android-App gesendet werden.'));
      }
    });
  }

  private disconnect(message: string): void {
    if (this.port) {
      this.port.onmessage = null;
      this.port.onmessageerror = null;
      this.port.close();
      this.port = null;
    }
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(message));
    }
    this.pending.clear();
  }

  private failConnection(message: string): void {
    this.disconnect(message);
    this.setSnapshot({ status: 'error', error: message });
  }
}

let browserClient: AndroidAlarmClient | undefined;
export function getAndroidAlarmClient(): AndroidAlarmClient {
  if (!browserClient) browserClient = new AndroidAlarmClient(typeof window === 'undefined' ? undefined : window);
  browserClient.start();
  return browserClient;
}

// Register before AccountBoundary's asynchronous account check or a settings
// mount, so native onPageFinished can safely transfer its single-use port.
if (typeof window !== 'undefined') getAndroidAlarmClient();
