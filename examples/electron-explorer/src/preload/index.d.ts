import type { DrasiApi } from '../shared/types.js';

declare global {
  interface Window {
    drasi: DrasiApi;
  }
}

export {};
