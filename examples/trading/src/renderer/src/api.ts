import { useEffect, useMemo, useRef, useState } from 'react';
import type { Column, QuerySpec } from '@shared/queries';
import type { ResultDiff, StreamEnvelope } from '@shared/types';

export const trading = window.trading;

type Row = Record<string, unknown>;

/** Stable key for a row: business key first, then engine row_signature. */
function diffKey(spec: QuerySpec, diff: Extract<ResultDiff, { type: 'ADD' | 'UPDATE' | 'DELETE' | 'aggregation' }>): string {
  const payload = diff.type === 'UPDATE' || diff.type === 'aggregation' ? diff.after : diff.data;
  const business = payload?.[spec.key];
  if (business !== undefined && business !== null) return String(business);
  if (diff.row_signature !== undefined) return String(diff.row_signature);
  return JSON.stringify(payload);
}

function rowKey(spec: QuerySpec, row: Row): string {
  const business = row[spec.key];
  return business !== undefined && business !== null ? String(business) : JSON.stringify(row);
}

/**
 * Live result set for a query: seeds from a snapshot, then applies ADD/UPDATE/
 * DELETE/aggregation diffs streamed from the engine's application reaction.
 */
export function useQuery(spec: QuerySpec): Row[] {
  const [rows, setRows] = useState<Map<string, Row>>(new Map());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    trading
      .getResults(spec.id)
      .then((snap) => {
        if (!mounted.current) return;
        const m = new Map<string, Row>();
        for (const r of snap) m.set(rowKey(spec, r), r);
        setRows(m);
      })
      .catch(() => undefined);

    const unsubscribe = trading.onResults((env: StreamEnvelope) => {
      if (env.queryId !== spec.id) return;
      setRows((prev) => {
        const next = new Map(prev);
        for (const d of env.result.results) {
          if (d.type === 'ADD') next.set(diffKey(spec, d), d.data);
          else if (d.type === 'UPDATE' || d.type === 'aggregation') next.set(diffKey(spec, d), d.after);
          else if (d.type === 'DELETE') next.delete(diffKey(spec, d));
        }
        return next;
      });
    });

    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [spec]);

  return useMemo(() => {
    const list = [...rows.values()];
    const sort = spec.sort;
    if (sort) {
      list.sort((a, b) => {
        const av = a[sort.field];
        const bv = b[sort.field];
        if (typeof av === 'number' && typeof bv === 'number') {
          return sort.dir === 'asc' ? av - bv : bv - av;
        }
        return sort.dir === 'asc'
          ? String(av).localeCompare(String(bv))
          : String(bv).localeCompare(String(av));
      });
    }
    return list;
  }, [rows, spec]);
}

/** Format a cell value according to its column's format. */
export function formatCell(value: unknown, column: Column): string {
  if (value === null || value === undefined) return '—';
  const num = typeof value === 'number' ? value : Number(value);
  switch (column.format) {
    case 'currency':
      return Number.isFinite(num) ? `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(value);
    case 'percent':
      return Number.isFinite(num) ? `${num >= 0 ? '+' : ''}${num.toFixed(2)}%` : String(value);
    case 'integer':
      return Number.isFinite(num) ? Math.round(num).toLocaleString() : String(value);
    case 'number':
      return Number.isFinite(num) ? num.toLocaleString() : String(value);
    default:
      return String(value);
  }
}

/** Sign class for signed columns (green/red), else empty. */
export function signClass(value: unknown, column: Column): string {
  if (!column.signed) return '';
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num === 0) return '';
  return num > 0 ? 'pos' : 'neg';
}
