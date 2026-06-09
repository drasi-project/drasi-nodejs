// Canonical IPC channel names. `invoke`/`handle` request-response channels are
// namespaced `drasi:<area>:<verb>`; the single push channel is STREAM_CHANNEL
// (see types.ts).

export const IPC = {
  browsePlugins: 'drasi:plugins:browse',
  listVersions: 'drasi:plugins:versions',
  installPlugin: 'drasi:plugins:install',
  importLocalPlugins: 'drasi:plugins:import',
  pluginKinds: 'drasi:plugins:kinds',

  addSource: 'drasi:source:add',
  addJsSource: 'drasi:source:addJs',
  pushChange: 'drasi:source:push',
  startSource: 'drasi:source:start',
  stopSource: 'drasi:source:stop',
  removeSource: 'drasi:source:remove',
  listSources: 'drasi:source:list',

  addQuery: 'drasi:query:add',
  startQuery: 'drasi:query:start',
  stopQuery: 'drasi:query:stop',
  removeQuery: 'drasi:query:remove',
  getQueryResults: 'drasi:query:results',
  listQueries: 'drasi:query:list',

  addReaction: 'drasi:reaction:add',
  startReaction: 'drasi:reaction:start',
  stopReaction: 'drasi:reaction:stop',
  removeReaction: 'drasi:reaction:remove',
  listReactions: 'drasi:reaction:list',

  getQueryMetrics: 'drasi:metrics:query',
  getReactionMetrics: 'drasi:metrics:reaction',
  getLifecycleMetrics: 'drasi:metrics:lifecycle',

  subscribeQueryResults: 'drasi:query:subscribe',
  pickFolder: 'drasi:dialog:pickFolder',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
