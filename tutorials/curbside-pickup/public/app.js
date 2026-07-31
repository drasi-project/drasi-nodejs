// Curbside Pickup — front-end logic (vanilla JS, no framework).
//
// Seeds current state from /api/state, then opens a SINGLE EventSource at
// /events (the app multiplexes every SSE reaction route into that one stream,
// tagging each event with its path) and merges each Handlebars-shaped change
// { op, row } into per-stream maps. The two "operational" lists (Orders,
// Vehicles) are the union of their filtered streams and carry the toggle
// buttons; the two "live" panels (Matched, Delayed) render straight from the
// join / temporal streams. Every toggle writes to a database, so Drasi reacts
// through CDC and the change streams back here.

const el = (sel) => document.querySelector(sel);
const dom = {
  status: el("#status"),
  orders: el("#orders"),
  vehicles: el("#vehicles"),
  delivery: el("#delivery"),
  delay: el("#delay"),
  log: el("#log"),
  reset: el("#reset"),
};

const STREAMS = [
  "orders-preparing",
  "orders-ready",
  "vehicles-parking",
  "vehicles-curbside",
  "delivery",
  "delay",
];
const state = Object.fromEntries(STREAMS.map((s) => [s, new Map()]));
let sqlLog = [];
let renderScheduled = false;

// ---------- API helpers ----------
async function post(url) {
  const res = await fetch(url, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  if (body.log) sqlLog = body.log;
  return body;
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

function unionById(...maps) {
  const out = new Map();
  for (const m of maps) for (const [id, row] of m) out.set(id, row);
  return [...out.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}

function render() {
  // --- Orders (PostgreSQL): union of preparing + ready, with a toggle. ---
  const orders = unionById(state["orders-preparing"], state["orders-ready"]);
  dom.orders.innerHTML = orders.length
    ? orders.map(orderRow).join("")
    : `<li class="empty">No orders.</li>`;

  // --- Vehicles (MySQL): union of parking + curbside, with a toggle. ---
  const vehicles = unionById(state["vehicles-parking"], state["vehicles-curbside"]);
  dom.vehicles.innerHTML = vehicles.length
    ? vehicles.map(vehicleRow).join("")
    : `<li class="empty">No vehicles.</li>`;

  // --- Matched (delivery join). ---
  const matched = [...state.delivery.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  dom.delivery.innerHTML = matched.length
    ? matched.map(deliveryRow).join("")
    : `<li class="empty">No orders ready with a driver at the curbside.</li>`;

  // --- Delayed (temporal delay query). ---
  const delayed = [...state.delay.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  dom.delay.innerHTML = delayed.length
    ? delayed.map(delayRow).join("")
    : `<li class="empty">No delayed orders.</li>`;

  renderLog();
}

function orderRow(o) {
  const ready = o.status === "ready";
  const next = ready ? "Mark preparing" : "Mark ready";
  return `<li class="row">
    <div class="row__main">
      <div class="row__title">Order ${escapeHtml(o.orderId)} · ${escapeHtml(o.customerName)}</div>
      <div class="row__sub">driver ${escapeHtml(o.driverName)} · <span class="plate">${escapeHtml(o.plate)}</span></div>
    </div>
    <div class="row__right">
      <span class="badge badge--${escapeAttr(o.status)}">${escapeHtml(o.status)}</span>
      <button class="btn btn--go" data-order="${escapeAttr(o.id)}">${next}</button>
    </div>
  </li>`;
}

function vehicleRow(v) {
  const curb = v.location === "Curbside";
  const next = curb ? "To parking" : "To curbside";
  return `<li class="row">
    <div class="row__main">
      <div class="row__title"><span class="plate">${escapeHtml(v.plate)}</span> · ${escapeHtml(v.color)} ${escapeHtml(v.make)} ${escapeHtml(v.model)}</div>
    </div>
    <div class="row__right">
      <span class="badge badge--${escapeAttr(v.location)}">${escapeHtml(v.location)}</span>
      <button class="btn btn--go" data-vehicle="${escapeAttr(v.plate)}">${next}</button>
    </div>
  </li>`;
}

function deliveryRow(d) {
  return `<li class="row live">
    <div class="row__main">
      <div class="row__title">📦 Order ${escapeHtml(d.orderId)} · driver ${escapeHtml(d.driverName)}</div>
      <div class="row__sub">${escapeHtml(d.vehicleColor)} ${escapeHtml(d.vehicleMake)} ${escapeHtml(d.vehicleModel)} <span class="plate">${escapeHtml(d.vehicleId)}</span> at the curbside</div>
    </div>
    <div class="row__right"><span class="badge badge--ready">ready</span></div>
  </li>`;
}

function delayRow(d) {
  return `<li class="row live live--delay">
    <div class="row__main">
      <div class="row__title">⚠️ Order ${escapeHtml(d.orderId)} · ${escapeHtml(d.customerName)}</div>
      <div class="row__sub">waiting since ${escapeHtml(fmtTime(d.waitingSince))}</div>
    </div>
  </li>`;
}

function renderLog() {
  if (!sqlLog.length) {
    dom.log.innerHTML = `<li class="empty">No changes yet — toggle an order or a vehicle.</li>`;
    return;
  }
  dom.log.innerHTML = [...sqlLog]
    .reverse()
    .map(
      (e) =>
        `<li><span class="log__db log__db--${escapeAttr(e.db)}">${escapeHtml(e.db)}</span><span class="log__sql">${escapeHtml(e.text)}</span></li>`,
    )
    .join("");
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
    for (const row of (data.streams && data.streams[path]) || []) state[path].set(row.id, row);
  }
  if (data.log) sqlLog = data.log;
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
document.body.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-order], button[data-vehicle]");
  if (!btn) return;
  btn.disabled = true;
  try {
    if (btn.dataset.order != null) await post(`/api/orders/${btn.dataset.order}/toggle`);
    else await post(`/api/vehicles/${encodeURIComponent(btn.dataset.vehicle)}/toggle`);
    renderLog();
  } catch (err) {
    alert(`Could not apply change: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

dom.reset.addEventListener("click", async () => {
  dom.reset.disabled = true;
  try {
    await post("/api/reset");
    renderLog();
  } catch (err) {
    alert(`Reset failed: ${err.message}`);
  } finally {
    dom.reset.disabled = false;
  }
});

seedState()
  .catch((err) => console.error("initial state failed", err))
  .finally(connectStreams);

// ---------- helpers ----------
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleTimeString();
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#96;");
}
