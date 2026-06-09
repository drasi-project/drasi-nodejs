import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentStatusEntry, StreamEnvelope } from '@shared/types';

/** The engine API exposed by the preload bridge. */
export const drasi = window.drasi;

/**
 * Subscribe to the live stream of engine events/logs/results for the lifetime
 * of the component. `handler` is kept in a ref so re-renders don't re-subscribe.
 */
export function useStream(handler: (env: StreamEnvelope) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const unsubscribe = drasi.onStream((env) => ref.current(env));
    return unsubscribe;
  }, []);
}

/** Format an unknown error into a readable string. */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Fetch a component list and keep it fresh: refreshes on mount and whenever a
 * lifecycle event arrives on the stream.
 */
export function useComponentList(
  list: () => Promise<ComponentStatusEntry[]>,
): { items: ComponentStatusEntry[]; refresh: () => void } {
  const [items, setItems] = useState<ComponentStatusEntry[]>([]);
  const refresh = useCallback(() => {
    list()
      .then(setItems)
      .catch(() => undefined);
  }, [list]);
  useEffect(() => refresh(), [refresh]);
  useStream((env) => {
    if (env.kind === 'event') refresh();
  });
  return { items, refresh };
}
