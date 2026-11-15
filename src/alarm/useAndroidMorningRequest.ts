import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getAndroidAlarmClient, type AndroidAlarmClient } from './androidAlarmClient';
import type { AndroidMorningRequest } from './protocol';

type OpenRoutine = (request: AndroidMorningRequest) => boolean | Promise<boolean>;
type MorningClient = Pick<AndroidAlarmClient, 'consumeMorningRequest' | 'acknowledgeMorningRequest'>;

/** A callback must confirm loaded planner + navigation; false leaves native pending. */
export async function deliverAndroidMorningRequest(client: MorningClient, openRoutine: OpenRoutine, canAcknowledge = () => true): Promise<'none' | 'deferred' | 'acknowledged' | 'superseded'> {
  const request = await client.consumeMorningRequest();
  if (!request) return 'none';
  if (!await openRoutine(request) || !canAcknowledge()) return 'deferred';
  return await client.acknowledgeMorningRequest(request.requestId) ? 'acknowledged' : 'superseded';
}

/** No planner mutation is performed here. Materialize through the existing store. */
export function useAndroidMorningRequest(onRequest: OpenRoutine, options: { enabled: boolean; client?: AndroidAlarmClient }) {
  const client = options.client ?? getAndroidAlarmClient();
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const callback = useRef(onRequest);
  callback.current = onRequest;
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!options.enabled || snapshot.status !== 'ready') return;
    let active = true;
    let running = false;
    let checkAgain = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRetry = () => {
      if (active && retryTimer === undefined) retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void check();
      }, 15_000);
    };
    const check = async () => {
      if (!active) return;
      if (running) { checkAgain = true; return; }
      running = true;
      checkAgain = false;
      if (retryTimer !== undefined) { clearTimeout(retryTimer); retryTimer = undefined; }
      setError('');
      try {
        const result = await deliverAndroidMorningRequest(client, request => active ? callback.current(request) : false, () => active);
        if (result === 'superseded') checkAgain = true;
        if (result === 'deferred') scheduleRetry();
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : 'Der Morgenstart konnte nicht geladen werden.');
          scheduleRetry();
        }
      } finally {
        running = false;
        if (active && checkAgain) void check();
      }
    };
    const unsubscribe = client.subscribeMorningRequest(() => { void check(); });
    void check();
    return () => { active = false; unsubscribe(); if (retryTimer !== undefined) clearTimeout(retryTimer); };
  }, [client, options.enabled, snapshot.status, retryCount]);

  return { error, retry: () => setRetryCount(count => count + 1) };
}
