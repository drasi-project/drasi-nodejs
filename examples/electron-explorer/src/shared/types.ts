// Shared types: the contract between the Electron main process (which owns the
// embedded @drasi/lib), the preload bridge, and the React renderer.

/** A component's id and its current status string (e.g. "Running", "Stopped"). */
export interface ComponentStatusEntry {
  id: string;
  status: string;
}

/** Registered plugin kinds, as reported by the engine. */
export interface PluginKinds {
  sources: string[];
  reactions: string[];
  bootstrap: string[];
}

/** One row-diff inside a query result (internally tagged on `type`). */
export type ResultDiff =
  | { type: 'ADD'; data: unknown; row_signature?: number }
  | { type: 'DELETE'; data: unknown; row_signature?: number }
  | { type: 'UPDATE'; data: unknown; before: unknown; after: unknown; row_signature?: number }
  | { type: 'aggregation'; before?: unknown; after: unknown; row_signature?: number }
  | { type: 'noop' };

/** A query result emission delivered to JS reactions / result streams. */
export interface QueryResultEvent {
  query_id: string;
  sequence: number;
  timestamp: string;
  results: ResultDiff[];
  metadata: Record<string, unknown>;
}

/** A component log line. */
export interface LogMessage {
  timestamp: string;
  level: string;
  message: string;
  instance_id: string;
  component_id: string;
  component_type: string;
}

/** A component lifecycle/status event (shape is engine-defined; kept loose). */
export type ComponentEvent = Record<string, unknown>;

// ---- Plugin discovery / install -------------------------------------------

export type PluginType = 'source' | 'reaction' | 'bootstrap';

/** An entry in the OCI plugin directory (`drasi-plugin-directory` tags). */
export interface DirectoryEntry {
  type: PluginType;
  kind: string;
  /** OCI repository, e.g. "source/postgres". */
  repository: string;
}

/** Cosign verification outcome from installPlugin / pullPlugin. */
export type PullPluginVerification =
  | { status: 'unsigned' }
  | { status: 'verified'; issuer?: string; subject?: string }
  | { status: 'tampered'; reason?: string };

/** How installPlugin resolved a bare repository ref for this host. */
export interface ResolvedPlugin {
  reference: string;
  version: string;
  sdkVersion: string;
  coreVersion: string;
  libVersion: string;
  platform: string;
  digest: string;
  filename: string;
}

export interface InstallResult {
  path: string;
  resolved: ResolvedPlugin;
  verification: PullPluginVerification;
  /** Plugin kinds registered after install. */
  kinds: PluginKinds;
}

// ---- Create-component request shapes --------------------------------------

export interface AddSourceRequest {
  kind: string;
  id: string;
  config: Record<string, unknown>;
  autoStart?: boolean;
  bootstrap?: { kind: string; config?: Record<string, unknown> };
}

export interface AddQueryRequest {
  id: string;
  query: string;
  sources: string[];
  language?: 'cypher' | 'gql';
}

export interface AddReactionRequest {
  kind: string;
  id: string;
  queries: string[];
  config: Record<string, unknown>;
}

export interface SourceChangeInput {
  op: 'insert' | 'update' | 'delete';
  id: string;
  labels?: string[];
  properties?: Record<string, unknown>;
  startId?: string;
  endId?: string;
  effectiveFrom?: number;
}

// ---- Streaming envelopes (main -> renderer via webContents.send) ----------

export type StreamKind = 'event' | 'log' | 'result';

/** Envelope pushed to the renderer for live streams. */
export interface StreamEnvelope {
  kind: StreamKind;
  /** Component/query id this item pertains to (when applicable). */
  id?: string;
  payload: ComponentEvent | LogMessage | QueryResultEvent;
}

export const STREAM_CHANNEL = 'drasi:stream';

/** The API surface exposed on `window.drasi` by the preload bridge. */
export interface DrasiApi {
  // discovery / install
  browsePlugins(): Promise<DirectoryEntry[]>;
  /** Install the latest host-compatible build of a bare repository ref. */
  installPlugin(repository: string): Promise<InstallResult>;
  importLocalPlugins(dir: string): Promise<PluginKinds>;
  pluginKinds(): Promise<PluginKinds>;

  // sources
  addSource(req: AddSourceRequest): Promise<void>;
  addJsSource(id: string, autoStart?: boolean): Promise<void>;
  pushChange(sourceId: string, change: SourceChangeInput): Promise<void>;
  startSource(id: string): Promise<void>;
  stopSource(id: string): Promise<void>;
  removeSource(id: string, cleanup?: boolean): Promise<void>;
  listSources(): Promise<ComponentStatusEntry[]>;

  // queries
  addQuery(req: AddQueryRequest): Promise<void>;
  startQuery(id: string): Promise<void>;
  stopQuery(id: string): Promise<void>;
  removeQuery(id: string): Promise<void>;
  getQueryResults(id: string): Promise<unknown[]>;
  listQueries(): Promise<ComponentStatusEntry[]>;

  // reactions
  addReaction(req: AddReactionRequest): Promise<void>;
  startReaction(id: string): Promise<void>;
  stopReaction(id: string): Promise<void>;
  removeReaction(id: string, cleanup?: boolean): Promise<void>;
  listReactions(): Promise<ComponentStatusEntry[]>;

  // observability
  getQueryMetrics(id: string): Promise<unknown>;
  getReactionMetrics(id: string): Promise<unknown>;
  getLifecycleMetrics(): Promise<unknown>;

  // live streams (returns an unsubscribe fn)
  onStream(cb: (env: StreamEnvelope) => void): () => void;

  // misc
  pickFolder(): Promise<string | null>;
}
