// Companion TypeScript helper types for the generated index.d.ts, whose config/result shapes are any.

export interface SourceChangeInput {
  op: 'insert' | 'update' | 'delete'
  id: string
  labels?: string[]
  properties?: Record<string, unknown>
  startId?: string
  endId?: string
  effectiveFrom?: number
}

export type ResultDiff =
  | {
      type: 'ADD'
      data: unknown
      row_signature?: number
    }
  | {
      type: 'DELETE'
      data: unknown
      row_signature?: number
    }
  | {
      type: 'UPDATE'
      data: unknown
      before: unknown
      after: unknown
      row_signature?: number
    }
  | {
      type: 'aggregation'
      before?: unknown
      after: unknown
      row_signature?: number
    }
  | {
      type: 'noop'
    }

export interface QueryResultEvent {
  query_id: string
  sequence: number
  timestamp: string
  results: ResultDiff[]
  metadata: Record<string, unknown>
}

export interface LogMessage {
  timestamp: string
  level: string
  message: string
  instance_id: string
  component_id: string
  component_type: string
}

export type ComponentEvent = Record<string, unknown>

export interface CreateOptions {
  secrets?: Record<string, string>
  stateStore?: {
    kind: 'redb'
    path: string
  }
}

export interface QueryJoinKey {
  label: string
  property: string
}

export interface QueryJoin {
  id: string
  keys: QueryJoinKey[]
}

export interface DrasiConfig {
  id?: string
  secrets?: Record<string, string>
  stateStore?: {
    kind: 'redb'
    path: string
  }
  pluginsDir?: string
  sources?: Array<{
    kind: string
    id: string
    config?: Record<string, unknown>
    autoStart?: boolean
    bootstrap?: {
      kind: string
      config?: Record<string, unknown>
    }
  }>
  queries?: Array<{
    id: string
    query: string
    sources: string[]
    language?: 'cypher' | 'gql'
    joins?: QueryJoin[]
  }>
  reactions?: Array<{
    kind: string
    id: string
    queries: string[]
    config?: Record<string, unknown>
  }>
}

export interface ComponentStatusEntry {
  id: string
  status: string
}
