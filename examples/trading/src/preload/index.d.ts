import type { TradingApi } from '../shared/types.js';

declare global {
  interface Window {
    trading: TradingApi;
  }
}

export {};
