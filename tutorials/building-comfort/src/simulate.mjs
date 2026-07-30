// Server-side simulation loop. When enabled it picks a random room every few
// seconds and assigns new random readings that straddle the comfortable band
// (40-50), so comfort levels rise and fall and alerts come and go on their own.
// Toggled from the UI via POST /api/simulate. Each tick writes to PostgreSQL,
// so Drasi reacts through CDC just like a manual change.

import { setRoom, listRoomIds } from './db.mjs';

const DEFAULT_INTERVAL_MS = 3000;

export function createSimulator({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  let timer = null;
  let roomIds = [];

  function randomReadings() {
    return {
      temperature: 55 + Math.floor(Math.random() * 31), // 55 - 85
      humidity: 20 + Math.floor(Math.random() * 36), //     20 - 55
      co2: 5 + Math.floor(Math.random() * 900), //          5 - 904
    };
  }

  async function tick() {
    if (roomIds.length === 0) return;
    const id = roomIds[Math.floor(Math.random() * roomIds.length)];
    try {
      await setRoom(id, randomReadings());
    } catch (err) {
      console.error('[simulate] update failed:', err.message);
    }
  }

  return {
    isRunning: () => timer !== null,
    async start() {
      if (timer) return;
      roomIds = await listRoomIds();
      timer = setInterval(() => {
        tick().catch(() => {});
      }, intervalMs);
      console.log(`[simulate] started (${roomIds.length} rooms, every ${intervalMs}ms)`);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      console.log('[simulate] stopped');
    },
  };
}
