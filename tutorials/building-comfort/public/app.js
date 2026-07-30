// Building Comfort — front-end logic (vanilla JS, no framework).
//
// 1. Subscribe to the SSE stream at /events and render each shaped snapshot.
// 2. Drive changes through the app's control endpoints (which write to Postgres,
//    so Drasi reacts through CDC — the app never mutates the UI directly).

const el = (sel) => document.querySelector(sel);

const dom = {
  status: el("#status"),
  buildingName: el("#building-name"),
  overall: el("#overall-comfort"),
  gauge: el("#gauge"),
  building: el("#building"),
  buildingEmpty: el("#building-empty"),
  roomAlerts: el("#room-alerts"),
  floorAlerts: el("#floor-alerts"),
  resetAll: el("#reset-all"),
  simToggle: el("#sim-toggle"),
};

// Keyed room-card registry so we update in place instead of rebuilding the DOM
// on every snapshot (which would fight the user's typing).
const cards = new Map(); // roomId -> { root, refs }
let renderedRoomKey = "";

const STATUS_LABEL = { ok: "🟢 comfortable", hot: "🔴 too hot", cold: "🔵 too cold", unknown: "…" };

function classFor(status) {
  return status === "hot" || status === "cold" ? status : "ok";
}

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

// ---------- Rendering ----------
function roomKey(snapshot) {
  return snapshot.floors.flatMap((f) => f.rooms.map((r) => r.roomId)).join("|");
}

function buildSkeleton(snapshot) {
  cards.clear();
  dom.building.innerHTML = "";
  for (const floor of snapshot.floors) {
    const section = document.createElement("section");
    section.className = "floor";
    section.innerHTML = `
      <div class="floor__head">
        <h2>${escapeHtml(floor.floorName)}</h2>
        <span class="floor__comfort" data-floor="${escapeAttr(floor.floorId)}">comfort <b>–</b></span>
      </div>
      <div class="rooms"></div>`;
    const roomsWrap = section.querySelector(".rooms");
    for (const room of floor.rooms) {
      roomsWrap.appendChild(buildCard(room));
    }
    dom.building.appendChild(section);
  }
}

function buildCard(room) {
  const root = document.createElement("div");
  root.className = "room";
  root.dataset.room = room.roomId;
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
  cards.set(room.roomId, { root, refs });
  return root;
}

function updateCard(room) {
  const entry = cards.get(room.roomId);
  if (!entry) return;
  const { root, refs } = entry;
  const cls = classFor(room.status);
  root.className = `room room--${cls}`;
  refs.name.textContent = room.roomName;
  refs.badge.textContent = STATUS_LABEL[room.status] || STATUS_LABEL.unknown;
  refs.badge.className = `room__badge badge--${cls}`;
  refs.comfort.textContent = room.comfortLevel ?? "–";
  refs.temp.textContent = room.temperature ?? "–";
  refs.hum.textContent = room.humidity ?? "–";
  refs.co2.textContent = room.co2 ?? "–";
  // Refresh the input defaults, but never yank a value the user is editing.
  setUnlessFocused(refs.inTemp, room.temperature);
  setUnlessFocused(refs.inHum, room.humidity);
  setUnlessFocused(refs.inCo2, room.co2);
}

function setUnlessFocused(input, value) {
  if (document.activeElement !== input) input.value = value ?? "";
}

function render(snapshot) {
  dom.buildingName.textContent = snapshot.buildingName || "Building Comfort";

  // Overall comfort gauge.
  const overall = snapshot.overallComfort;
  dom.overall.textContent = overall == null ? "–" : overall;
  const gcls = overall == null ? "" : overall > 50 ? "hot" : overall < 40 ? "cold" : "ok";
  dom.gauge.className = `gauge${gcls ? ` gauge--${gcls}` : ""}`;

  // Rebuild the grid only when the set of rooms changes.
  const key = roomKey(snapshot);
  if (key !== renderedRoomKey) {
    renderedRoomKey = key;
    if (snapshot.floors.length === 0) {
      dom.building.innerHTML = '<p class="empty">Waiting for data…</p>';
      cards.clear();
    } else {
      buildSkeleton(snapshot);
    }
  }

  // Update room cards in place.
  for (const floor of snapshot.floors) {
    for (const room of floor.rooms) updateCard(room);
  }

  // Per-floor comfort next to each floor heading.
  const floorComfort = new Map(snapshot.floorComfort.map((f) => [f.floorId, f.comfortLevel]));
  document.querySelectorAll(".floor__comfort").forEach((node) => {
    const val = floorComfort.get(node.dataset.floor);
    node.innerHTML = `comfort <b>${val ?? "–"}</b>`;
  });

  renderAlerts(dom.roomAlerts, snapshot.roomAlerts, "All rooms are comfortable.", (a) =>
    `⚠️ <strong>${escapeHtml(a.roomName)}</strong> <code>${escapeHtml(a.roomId)}</code> — comfort <b>${a.comfortLevel}</b>`,
  );
  renderAlerts(dom.floorAlerts, snapshot.floorAlerts, "All floors are comfortable.", (a) =>
    `⚠️ <strong>${escapeHtml(a.floorName)}</strong> — comfort <b>${a.comfortLevel}</b>`,
  );
}

function renderAlerts(container, items, okText, fmt) {
  if (!items || items.length === 0) {
    container.innerHTML = `<li class="alert-list__ok">✅ ${okText}</li>`;
    return;
  }
  container.innerHTML = items.map((a) => `<li class="warn">${fmt(a)}</li>`).join("");
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

// ---------- SSE connection ----------
function connect() {
  const source = new EventSource("/events");
  source.addEventListener("snapshot", (e) => {
    try {
      render(JSON.parse(e.data));
    } catch (err) {
      console.error("bad snapshot", err);
    }
  });
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

// Reflect current simulation state on load.
fetch("/api/simulate")
  .then((r) => r.json())
  .then(({ running }) => {
    dom.simToggle.checked = Boolean(running);
  })
  .catch(() => {});

connect();

// ---------- small escaping helpers ----------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#96;");
}
