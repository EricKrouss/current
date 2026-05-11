import { useEffect, useMemo, useRef, useState } from 'react';

export interface GatewayEnvelope {
  id: string;
  type: string;
  payload: unknown;
  seq?: number;
  sentAt: string;
}

export function useGateway(enabled: boolean, onEvent: (event: GatewayEnvelope) => void) {
  const [status, setStatus] = useState<'offline' | 'connecting' | 'online'>('offline');
  const [lastSeq, setLastSeq] = useState(0);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setStatus('offline');
      return;
    }

    setStatus('connecting');
    const socket = new WebSocket(`/gateway?lastEventSeq=${lastSeqRef.current}`);

    socket.addEventListener('open', () => {
      setStatus('online');
    });

    socket.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(event.data as string) as GatewayEnvelope;
        if (typeof parsed.seq === 'number') {
          setLastSeq((prev) => {
            const next = Math.max(prev, parsed.seq ?? 0);
            lastSeqRef.current = next;
            return next;
          });
          socket.send(
            JSON.stringify({
              id: `ack_${parsed.id}`,
              type: 'ACK',
              payload: { seq: parsed.seq },
              sentAt: new Date().toISOString(),
            }),
          );
        }
        onEvent(parsed);
      } catch {
        // no-op
      }
    });

    socket.addEventListener('close', (event) => {
      setStatus('offline');
      if (event.code === 1008 && event.reason.trim().length > 0) {
        onEvent({
          id: `close_${Date.now()}`,
          type: 'GATEWAY_CLOSE',
          payload: {
            code: event.code,
            reason: event.reason,
          },
          sentAt: new Date().toISOString(),
        });
      }
    });

    return () => {
      socket.close();
    };
  }, [enabled, onEvent]);

  return useMemo(
    () => ({
      status,
      lastSeq,
    }),
    [lastSeq, status],
  );
}
