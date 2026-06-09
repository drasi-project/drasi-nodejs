// In-process stock price generator — replaces drasi-server's Python price feed
// (mock-generator/simple_price_generator.py). Seeds initial prices from
// data/initial-prices.json, then random-walks each price on an interval and
// pushes `stock_prices` node upserts into the `price-feed` JS source. No HTTP,
// no external process.

import { readFileSync } from 'node:fs';
import type { Engine } from './engine-host.js';
import { SOURCE_PRICES } from '../shared/queries.js';

interface SeedPrice {
  symbol: string;
  price: number;
  volume: number;
}

interface PriceState {
  symbol: string;
  price: number;
  previousClose: number; // fixed "prior day close" so change% is meaningful
}

const TICK_MS = 1000;
const VOLATILITY = 0.01; // ~1% std-dev step per tick

/** Standard-normal sample via Box–Muller. */
function gaussian(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function randomVolume(): number {
  const base = 1_000_000 + Math.floor(Math.random() * 49_000_000);
  return Math.floor(base * (1 + (Math.random() - 0.5) * 0.6));
}

export class PriceFeed {
  private states: PriceState[];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly engine: Engine,
    seedFile: string,
  ) {
    const seeds = JSON.parse(readFileSync(seedFile, 'utf8')) as SeedPrice[];
    this.states = seeds.map((s) => ({ symbol: s.symbol, price: s.price, previousClose: s.price }));
  }

  /** Emit the seed prices, then start the random-walk interval. */
  async start(): Promise<void> {
    for (const s of this.states) {
      await this.push(s, randomVolume());
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    for (const s of this.states) {
      const step = gaussian() * VOLATILITY * s.price;
      s.price = Math.max(s.price + step, 1);
      try {
        await this.push(s, randomVolume());
      } catch {
        // engine may be shutting down; stop quietly
      }
    }
  }

  private async push(s: PriceState, volume: number): Promise<void> {
    await this.engine.pushChange(SOURCE_PRICES, {
      op: 'update',
      id: `price_${s.symbol}`,
      labels: ['stock_prices'],
      properties: {
        symbol: s.symbol,
        price: Math.round(s.price * 100) / 100,
        previous_close: Math.round(s.previousClose * 100) / 100,
        volume,
        timestamp: new Date().toISOString(),
      },
    });
  }
}
