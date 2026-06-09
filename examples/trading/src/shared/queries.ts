// Query + synthetic-join definitions for the trading demo, ported verbatim from
// drasi-server/examples/trading (app/src/services/queries.ts). Each spec also
// carries the rendering metadata (title, row key, columns) the dashboard uses,
// keeping the engine topology and the UI in sync from one source of truth.

export interface JoinKey {
  label: string;
  property: string;
}

export interface QueryJoin {
  id: string;
  keys: JoinKey[];
}

export interface Column {
  field: string;
  label: string;
  format?: 'currency' | 'percent' | 'integer' | 'number';
  /** Color positive green / negative red (for change %, P&L). */
  signed?: boolean;
}

export interface QuerySpec {
  id: string;
  title: string;
  description: string;
  query: string;
  sources: string[];
  joins: QueryJoin[];
  /** Business-key field used to merge live row diffs. */
  key: string;
  columns: Column[];
  sort?: { field: string; dir: 'asc' | 'desc' };
}

export const SOURCE_POSTGRES = 'postgres-stocks';
export const SOURCE_PRICES = 'price-feed';

// --- Synthetic joins (relate elements across sources with no explicit FK) ---

/** stocks (Postgres) <-> stock_prices (live feed), by symbol. Cross-source. */
const HAS_PRICE: QueryJoin = {
  id: 'HAS_PRICE',
  keys: [
    { label: 'stocks', property: 'symbol' },
    { label: 'stock_prices', property: 'symbol' },
  ],
};

/** portfolio <-> stocks, by symbol. */
const OWNS_STOCK: QueryJoin = {
  id: 'OWNS_STOCK',
  keys: [
    { label: 'portfolio', property: 'symbol' },
    { label: 'stocks', property: 'symbol' },
  ],
};

/** watchlist <-> stocks, by symbol. */
const ON_WATCHLIST: QueryJoin = {
  id: 'ON_WATCHLIST',
  keys: [
    { label: 'watchlist', property: 'symbol' },
    { label: 'stocks', property: 'symbol' },
  ],
};

export const QUERIES: QuerySpec[] = [
  {
    id: 'watchlist-query',
    title: 'Watchlist',
    description: 'Three-way synthetic join: watchlist -> stocks -> live prices.',
    query: `
      MATCH (w:watchlist)-[:ON_WATCHLIST]->(s:stocks)-[:HAS_PRICE]->(sp:stock_prices)
      RETURN s.symbol AS symbol,
             s.name AS name,
             sp.price AS price,
             sp.previous_close AS previousClose,
             ((sp.price - sp.previous_close) / sp.previous_close * 100) AS changePercent
    `,
    sources: [SOURCE_POSTGRES, SOURCE_PRICES],
    joins: [ON_WATCHLIST, HAS_PRICE],
    key: 'symbol',
    columns: [
      { field: 'symbol', label: 'Symbol' },
      { field: 'name', label: 'Name' },
      { field: 'price', label: 'Price', format: 'currency' },
      { field: 'changePercent', label: 'Change %', format: 'percent', signed: true },
    ],
    sort: { field: 'changePercent', dir: 'desc' },
  },
  {
    id: 'portfolio-query',
    title: 'Portfolio P&L',
    description: 'Positions joined with company data + live prices; P&L recomputed on every tick.',
    query: `
      MATCH (p:portfolio)-[:OWNS_STOCK]->(s:stocks)-[:HAS_PRICE]->(sp:stock_prices)
      WITH p,
           s.name AS name,
           sp.price AS currentPrice,
           toFloat(p.purchase_price) AS avgCost,
           (sp.price * p.quantity) AS currentValue,
           (toFloat(p.purchase_price) * p.quantity) AS costBasis,
           ((sp.price - toFloat(p.purchase_price)) * p.quantity) AS profitLoss,
           ((sp.price - toFloat(p.purchase_price)) / toFloat(p.purchase_price) * 100) AS profitLossPercent
      RETURN p.id AS id,
             p.symbol AS symbol,
             p.quantity AS quantity,
             avgCost AS purchasePrice,
             name,
             currentPrice,
             currentValue,
             costBasis,
             profitLoss,
             profitLossPercent
    `,
    sources: [SOURCE_POSTGRES, SOURCE_PRICES],
    joins: [OWNS_STOCK, HAS_PRICE],
    key: 'id',
    columns: [
      { field: 'symbol', label: 'Symbol' },
      { field: 'quantity', label: 'Qty', format: 'integer' },
      { field: 'purchasePrice', label: 'Avg Cost', format: 'currency' },
      { field: 'currentPrice', label: 'Price', format: 'currency' },
      { field: 'currentValue', label: 'Value', format: 'currency' },
      { field: 'profitLoss', label: 'P&L', format: 'currency', signed: true },
      { field: 'profitLossPercent', label: 'P&L %', format: 'percent', signed: true },
    ],
    sort: { field: 'profitLossPercent', dir: 'desc' },
  },
  {
    id: 'top-gainers-query',
    title: 'Top Gainers',
    description: 'Filtered to stocks trading above their previous close.',
    query: `
      MATCH (s:stocks)-[:HAS_PRICE]->(sp:stock_prices)
      WHERE sp.price > sp.previous_close
      RETURN s.symbol AS symbol,
             s.name AS name,
             sp.price AS price,
             sp.previous_close AS previousClose,
             ((sp.price - sp.previous_close) / sp.previous_close * 100) AS changePercent
    `,
    sources: [SOURCE_POSTGRES, SOURCE_PRICES],
    joins: [HAS_PRICE],
    key: 'symbol',
    columns: [
      { field: 'symbol', label: 'Symbol' },
      { field: 'name', label: 'Name' },
      { field: 'price', label: 'Price', format: 'currency' },
      { field: 'changePercent', label: 'Change %', format: 'percent', signed: true },
    ],
    sort: { field: 'changePercent', dir: 'desc' },
  },
  {
    id: 'sector-performance-query',
    title: 'Sector Performance',
    description: 'Real-time aggregation (count / avg / sum / min / max) grouped by sector.',
    query: `
      MATCH (s:stocks)-[:HAS_PRICE]->(sp:stock_prices)
      RETURN s.sector AS sector,
             count(s) AS stockCount,
             avg((sp.price - sp.previous_close) / sp.previous_close * 100) AS avgChangePercent,
             sum(sp.volume) AS totalVolume,
             min(sp.price) AS minPrice,
             max(sp.price) AS maxPrice
    `,
    sources: [SOURCE_POSTGRES, SOURCE_PRICES],
    joins: [HAS_PRICE],
    key: 'sector',
    columns: [
      { field: 'sector', label: 'Sector' },
      { field: 'stockCount', label: 'Stocks', format: 'integer' },
      { field: 'avgChangePercent', label: 'Avg Change %', format: 'percent', signed: true },
      { field: 'totalVolume', label: 'Volume', format: 'integer' },
      { field: 'minPrice', label: 'Min', format: 'currency' },
      { field: 'maxPrice', label: 'Max', format: 'currency' },
    ],
    sort: { field: 'avgChangePercent', dir: 'desc' },
  },
  {
    id: 'price-ticker-query',
    title: 'Price Ticker',
    description: 'Single-source, high-frequency feed (no joins).',
    query: `
      MATCH (sp:stock_prices)
      RETURN sp.symbol AS symbol,
             sp.price AS price,
             sp.previous_close AS previousClose,
             ((sp.price - sp.previous_close) / sp.previous_close * 100) AS changePercent
    `,
    sources: [SOURCE_PRICES],
    joins: [],
    key: 'symbol',
    columns: [
      { field: 'symbol', label: 'Symbol' },
      { field: 'price', label: 'Price', format: 'currency' },
      { field: 'changePercent', label: 'Change %', format: 'percent', signed: true },
    ],
    sort: { field: 'symbol', dir: 'asc' },
  },
];
