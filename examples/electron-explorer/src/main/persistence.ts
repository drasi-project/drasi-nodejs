// Best-effort persistence of the created topology so it is restored on restart.
// Installed plugin binaries already persist in the plugins dir and are loaded at
// startup; this records the source/query/reaction definitions layered on top.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddQueryRequest, AddReactionRequest, AddSourceRequest } from '../shared/types.js';
import { paths } from './engine-host.js';

export interface StoredSource extends AddSourceRequest {
  js?: boolean;
}

export interface Topology {
  sources: StoredSource[];
  queries: AddQueryRequest[];
  reactions: AddReactionRequest[];
}

const empty = (): Topology => ({ sources: [], queries: [], reactions: [] });

let topology: Topology = empty();

export function loadTopology(): Topology {
  const file = paths().topologyFile;
  if (existsSync(file)) {
    try {
      topology = { ...empty(), ...JSON.parse(readFileSync(file, 'utf8')) };
    } catch {
      topology = empty();
    }
  }
  return topology;
}

function save(): void {
  try {
    writeFileSync(paths().topologyFile, JSON.stringify(topology, null, 2), 'utf8');
  } catch {
    // best-effort
  }
}

export function recordSource(s: StoredSource): void {
  topology.sources = topology.sources.filter((x) => x.id !== s.id);
  topology.sources.push(s);
  save();
}

export function recordQuery(q: AddQueryRequest): void {
  topology.queries = topology.queries.filter((x) => x.id !== q.id);
  topology.queries.push(q);
  save();
}

export function recordReaction(r: AddReactionRequest): void {
  topology.reactions = topology.reactions.filter((x) => x.id !== r.id);
  topology.reactions.push(r);
  save();
}

export function forgetSource(id: string): void {
  topology.sources = topology.sources.filter((x) => x.id !== id);
  save();
}

export function forgetQuery(id: string): void {
  topology.queries = topology.queries.filter((x) => x.id !== id);
  save();
}

export function forgetReaction(id: string): void {
  topology.reactions = topology.reactions.filter((x) => x.id !== id);
  save();
}
