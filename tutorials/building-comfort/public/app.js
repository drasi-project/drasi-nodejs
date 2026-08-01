// Building Comfort — front-end logic (vanilla JS, no framework).
//
// Data flow:
//   1. Seed current state from GET /api/state (the SSE reaction only streams
//      changes, so we need an initial snapshot).
//   2. Open a SINGLE EventSource at /events (the app multiplexes every SSE
//      reaction route into that one stream, tagging each event with its path).
//      Each message is a Handlebars-shaped change: { path, msg: { op, row } }.
//   3. Merge add/update/delete into per-stream maps and render.
//
// The app never mutates the UI directly: the control buttons write to Postgres,
// Drasi reacts through CDC, and the SSE reaction pushes the shaped change here.

const el = (sel) => document.querySelector(sel);

const dom = {
  status: el("#status"),
  buildingName: el("#building-name"),
  overall: el("#overall-comfort"),
  gauge: el("#gauge"),
  building: el("#building"),
  roomAlerts: el("#room-alerts"),
  floorAlerts: el("#floor-alerts"),
  resetAll: el("#reset-all"),
  simToggle: el("#sim-toggle"),
};

// One live map per SSE stream, keyed by row id.
const STREAMS = ["rooms", "floor-comfort", "building", "room-alerts", "floor-alerts"];
const state = Object.fromEntries(STREAMS.map((s) => [s, new Map()]));

const cards = new Map(); // roomId -> { root, refs }
let renderedRoomKey = "";
let renderScheduled = false;

const STATUS_LABEL = { ok: "🟢 comfortable", hot: "🔴 too hot", cold: "🔵 too cold" };
function statusOf(comfort) {
  const n = Number(comfort);
  if (!Number.isFinite(n)) return "ok";
  return n > 50 ? "hot" : n < 40 ? "cold" : "ok";
}
const round = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n)));

// ---------- API helpers ----------
async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    throw new Error(error || res.statusText);
  }
  return res.json();
}

// ---------- Derive the building shape from the room feed ----------
function floorsFromRooms() {
  const rooms = [...state.rooms.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const floors = new Map();
  for (const r of rooms) {
    if (!floors.has(r.floorId)) floors.set(r.floorId, { floorId: r.floorId, floorName: r.floor, rooms: [] });
    floors.get(r.floorId).rooms.push(r);
  }
  return [...floors.values()].sort((a, b) => String(a.floorId).localeCompare(String(b.floorId)));
}

function overallComfort() {
  const b = [...state.building.values()][0];
  return b ? round(b.comfort) : null;
}

// ---------- Rendering ----------
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function buildSkeleton(floors) {
  cards.clear();
  dom.building.innerHTML = "";
  for (const floor of floors) {
    const section = document.createElement("section");
    section.className = "floor";
    section.innerHTML = `
      <div class="floor__head">
        <h2>${escapeHtml(floor.floorName)}</h2>
        <span class="floor__comfort" data-floor="${escapeAttr(floor.floorId)}">comfort <b>–</b></span>
      </div>
      <div class="rooms"></div>`;
    const roomsWrap = section.querySelector(".rooms");
    for (const room of floor.rooms) roomsWrap.appendChild(buildCard(room));
    dom.building.appendChild(section);
  }
}

function buildCard(room) {
  const root = document.createElement("div");
  root.className = "room";
  root.dataset.room = room.id;
  root.innerHTML = `
    <div class="room__top">
      <span class="room__name"></span>
      <span class="room__badge"></span>
    </div>
    <div class="room__comfort">comfort <b>–</b></div>
    <div class="readings">
      <span>🌡️ <b class="r-temp">–</b>°F</span>
      <span>💧 <b class="r-hum">–</b>%</span>
      <span>🫧 <b class="r-co2">–</b></span>
    </div>
    <div class="room__actions">
      <button class="btn btn--warn" data-action="break">Break</button>
      <button class="btn" data-action="reset">Reset</button>
      <span class="field">🌡️<input class="in-temp" type="number" /></span>
      <span class="field">💧<input class="in-hum" type="number" /></span>
      <span class="field">🫧<input class="in-co2" type="number" /></span>
      <button class="btn" data-action="set">Set</button>
    </div>`;
  const refs = {
    name: root.querySelector(".room__name"),
    badge: root.querySelector(".room__badge"),
    comfort: root.querySelector(".room__comfort b"),
    temp: root.querySelector(".r-temp"),
    hum: root.querySelector(".r-hum"),
    co2: root.querySelector(".r-co2"),
    inTemp: root.querySelector(".in-temp"),
    inHum: root.querySelector(".in-hum"),
    inCo2: root.querySelector(".in-co2"),
  };
  cards.set(room.id, { root, refs });
  return root;
}

function updateCard(room) {
  const entry = cards.get(room.id);
  if (!entry) return;
  const { root, refs } = entry;
  const cls = statusOf(room.comfort);
  root.className = `room room--${cls}`;
  refs.name.textContent = room.name;
  refs.badge.textContent = STATUS_LABEL[cls];
  refs.badge.className = `room__badge badge--${cls}`;
  refs.comfort.textContent = round(room.comfort) ?? "–";
  refs.temp.textContent = room.temperature ?? "–";
  refs.hum.textContent = room.humidity ?? "–";
  refs.co2.textContent = room.co2 ?? "–";
  setUnlessFocused(refs.inTemp, room.temperature);
  setUnlessFocused(refs.inHum, room.humidity);
  setUnlessFocused(refs.inCo2, room.co2);
}

function setUnlessFocused(input, value) {
  if (document.activeElement !== input) input.value = value ?? "";
}

function render() {
  const rooms = [...state.rooms.values()];
  dom.buildingName.textContent = rooms[0]?.buildingName || "Building Comfort";

  const overall = overallComfort();
  dom.overall.textContent = overall == null ? "–" : overall;
  const gcls = overall == null ? "" : overall > 50 ? "hot" : overall < 40 ? "cold" : "ok";
  dom.gauge.className = `gauge${gcls ? ` gauge--${gcls}` : ""}`;

  const floors = floorsFromRooms();
  const key = floors.flatMap((f) => f.rooms.map((r) => r.id)).join("|");
  if (key !== renderedRoomKey) {
    renderedRoomKey = key;
    if (floors.length === 0) {
      dom.building.innerHTML = '<p class="empty">Waiting for data…</p>';
      cards.clear();
    } else {
      buildSkeleton(floors);
    }
  }
  for (const floor of floors) for (const room of floor.rooms) updateCard(room);

  // Per-floor comfort labels, from the floor-comfort stream.
  const floorComfort = state["floor-comfort"];
  document.querySelectorAll(".floor__comfort").forEach((node) => {
    const row = floorComfort.get(node.dataset.floor);
    node.innerHTML = `comfort <b>${row ? round(row.comfort) : "–"}</b>`;
  });

  renderAlerts(dom.roomAlerts, [...state["room-alerts"].values()], "All rooms are comfortable.", (a) =>
    `⚠️ <strong>${escapeHtml(a.name)}</strong> <code>${escapeHtml(a.id)}</code> — comfort <b>${round(a.comfort)}</b>`,
  );
  renderAlerts(dom.floorAlerts, [...state["floor-alerts"].values()], "All floors are comfortable.", (a) =>
    `⚠️ <strong>${escapeHtml(a.name)}</strong> — comfort <b>${round(a.comfort)}</b>`,
  );
}

function renderAlerts(container, items, okText, fmt) {
  if (!items || items.length === 0) {
    container.innerHTML = `<li class="alert-list__ok">✅ ${okText}</li>`;
    return;
  }
  items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  container.innerHTML = items.map((a) => `<li class="warn">${fmt(a)}</li>`).join("");
}

// ---------- Live data: seed + stream ----------
function applyChange(path, msg) {
  const map = state[path];
  if (!map || !msg || !msg.row || msg.row.id == null) return;
  if (msg.op === "delete") map.delete(msg.row.id);
  else map.set(msg.row.id, msg.row);
  scheduleRender();
}

async function seedState() {
  const data = await fetch("/api/state").then((r) => r.json());
  for (const path of STREAMS) {
    state[path].clear();
    for (const row of data[path] || []) state[path].set(row.id, row);
  }
  scheduleRender();
}

function connectStreams() {
  // ONE connection for every stream: the app fans the reaction's routes into
  // this single /events endpoint and tags each event with its stream path.
  const source = new EventSource("/events");
  source.onmessage = (e) => {
    try {
      const env = JSON.parse(e.data);
      applyChange(env.path, env.msg);
    } catch (err) {
      console.error("bad SSE message", err);
    }
  };
  source.onopen = () => {
    dom.status.textContent = "live";
    dom.status.className = "status status--on";
  };
  source.onerror = () => {
    dom.status.textContent = "reconnecting…";
    dom.status.className = "status status--off";
    // EventSource reconnects automatically.
  };
}

// ---------- Event handling ----------
dom.building.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const roomId = btn.closest(".room")?.dataset.room;
  if (!roomId) return;
  const refs = cards.get(roomId)?.refs;
  btn.disabled = true;
  try {
    if (btn.dataset.action === "reset") {
      await post(`/api/rooms/${roomId}/reset`);
    } else if (btn.dataset.action === "break") {
      await post(`/api/rooms/${roomId}`, { temperature: 40, humidity: 20, co2: 700 });
    } else if (btn.dataset.action === "set") {
      await post(`/api/rooms/${roomId}`, {
        temperature: Number(refs.inTemp.value),
        humidity: Number(refs.inHum.value),
        co2: Number(refs.inCo2.value),
      });
    }
  } catch (err) {
    alert(`Could not update ${roomId}: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

dom.resetAll.addEventListener("click", async () => {
  dom.resetAll.disabled = true;
  try {
    await post("/api/reset");
  } catch (err) {
    alert(`Reset failed: ${err.message}`);
  } finally {
    dom.resetAll.disabled = false;
  }
});

dom.simToggle.addEventListener("change", async () => {
  try {
    const { running } = await post("/api/simulate", { enabled: dom.simToggle.checked });
    dom.simToggle.checked = running;
  } catch (err) {
    dom.simToggle.checked = !dom.simToggle.checked;
    alert(`Could not toggle simulation: ${err.message}`);
  }
});

// Reflect current simulation state on load.
fetch("/api/simulate")
  .then((r) => r.json())
  .then(({ running }) => {
    dom.simToggle.checked = Boolean(running);
  })
  .catch(() => {});

// Seed, then stream.
seedState()
  .catch((err) => console.error("initial state failed", err))
  .finally(connectStreams);

// ---------- small escaping helpers ----------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#96;");
}
