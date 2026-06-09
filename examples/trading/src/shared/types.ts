// Types shared between the Electron main process, the preload bridge, and the
// renderer. Mirrors the result-diff shape emitted by @drasi/lib reactions.

export const STREAM_CHANNEL = 'trading:stream';

export type ResultDiff =
  | { type: 'ADD'; data: Record<string, unknown>; row_signature?: number }
  | { type: 'DELETE'; data: Record<string, unknown>; row_signature?: number }
  | {
      type: 'UPDATE';
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      row_signature?: number;
    }
  | { type: 'aggregation'; before?: Record<string, unknown>; after: Record<string, unknown>; row_signature?: number }
  | { type: 'noop' };

export interface QueryResultEvent {
  query_id: string;
  sequence: number;
  timestamp: string;
  results: ResultDiff[];
  metadata: Record<string, unknown>;
}

/** One live-results message pushed from main to the renderer. */
export interface StreamEnvelope {
  queryId: string;
  result: QueryResultEvent;
}

/** The minimal API exposed to the renderer via the preload bridge. */
export interface TradingApi {
  /** Current snapshot of a query's result set. */
  getResults(queryId: string): Promise<Array<Record<string, unknown>>>;
  /** Subscribe to live result diffs; returns an unsubscribe function. */
  onResults(cb: (env: StreamEnvelope) => void): () => void;
  /** Subscribe to fatal startup/engine errors; returns an unsubscribe function. */
  onError(cb: (message: string) => void): () => void;
}
