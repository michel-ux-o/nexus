import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AIStatus } from '../services/ai';

export function useAIConnection() {
  const [connection, setConnection] = useState<AIStatus | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [checking, setChecking] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const checkConnection = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setChecking(true);
    setConnection(null);
    setConnectionError('');
    try {
      const result = await api.getStatus(request.signal);
      if (!request.signal.aborted) setConnection(result);
    } catch (error) {
      if (!request.signal.aborted) setConnectionError(error instanceof Error ? error.message : 'Das KI-Backend ist nicht erreichbar.');
    } finally {
      if (!request.signal.aborted) setChecking(false);
    }
  }, []);
  useEffect(() => { void checkConnection(); return () => controller.current?.abort(); }, [checkConnection]);
  return { connection, connectionError, checking, checkConnection };
}
