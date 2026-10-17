"use strict";
// Plain JavaScript single-page app. No framework, no build step.
// All game rules live on the server; this file only shows data and sends requests.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n).toLocaleString("en-US");
const pct = (x) => (x * 100).toFixed(x < 0.001 ? 3 : 2) + "%";

let token = null;
try { token = localStorage.getItem("token"); } catch { /* storage may be blocked */ }
let me = null;
let currentTab = "cases";

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token && !path.startsWith("/auth")) logout();
    throw new Error(data.error || "Request failed (" + res.status + ")");
  }
  return data;
}

function toast(msg, kind = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = kind === "err" ? "err" : "ok";
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, "err"); } };

function setBalance(b) {
  me.balance = b;
  $("#balance").textContent = fmt(b);
}

function logout() {
  token = null; me = null;
  try { localStorage.removeItem("token"); } catch { /* ignore */ }
  boot();
}
$("#logout").onclick = logout;

// ---------- auth ----------
function renderAuth() {
  $("#topbar").hidden = true;
  $("#app").innerHTML = `
    <div class="card auth">
      <h2>Welcome to CaseSim</h2>
      <div class="tabs"><button class="ghost" data-mode="login">Log in</button><button class="ghost" data-mode="register">Sign up</button></div>
      <form id="authForm">
        <label>Nick</label><input name="nick" autocomplete="username" required maxlength="20">
        <label>Password</label><input name="password" type="password" autocomplete="current-password" required minlength="6">
        <div class="error" id="authErr"></div>
        <button class="primary" style="width:100%;margin-top:8px" id="authBtn">Log in</button>
      </form>
      <p class="muted">New players get starting coins. Virtual currency only.</p>
    </div>`;
  let mode = "login";
  const setMode = (m) => {
    mode = m;
    $("#authBtn").textContent = m === "login" ? "Log in" : "Create account";
    document.querySelectorAll(".auth .tabs button").forEach((b) => (b.style.borderColor = b.dataset.mode === m ? "var(--accent)" : ""));
  };
  document.querySelectorAll(".auth .tabs button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  setMode("login");
  $("#authForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const data = await api("/auth/" + mode, { method: "POST", body: { nick: f.get("nick"), password: f.get("password") } });
      token = data.token;
      try { localStorage.setItem("token", token); } catch { /* ignore */ }
      boot();
    } catch (err) { $("#authErr").textContent = err.message; }
  };
}

// ---------- shell ----------
const TABS = [["cases", "Cases"], ["inventory", "Inventory"], ["contracts", "Contracts"], ["leaderboard", "Leaderboard"], ["history", "History"]];

function renderShell() {
  $("#topbar").hidden = false;
  $("#nick").textContent = me.nick + (me.is_admin ? " (admin)" : "");
  $("#balance").textContent = fmt(me.balance);
  const tabs = me.is_admin ? [...TABS, ["admin", "Admin"]] : TABS;
  $("#tabs").innerHTML = tabs.map(([id, label]) => `<button data-tab="${id}" class="${id === currentTab ? "active" : ""}">${label}</button>`).join("");
  $("#tabs").querySelectorAll("button").forEach((b) => (b.onclick = () => { currentTab = b.dataset.tab; renderShell(); }));
  const view = { cases: viewCases, inventory: viewInventory, contracts: viewContracts, leaderboard: viewLeaderboard, history: viewHistory, admin: viewAdmin }[currentTab];
  Promise.resolve(view()).catch((e) => toast(e.message, "err"));
}

// ---------- shared pieces ----------
function itemCard(it, selected) {
  return `<div class="card item ${selected ? "selected" : ""}" data-id="${it.id}" style="--c:${esc(it.color)}">
    <img src="${esc(it.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">
    <div class="name">${esc(it.name)}</div>
    <div class="meta"><span>${esc(it.wear)}</span><span class="price">${fmt(it.price)}</span></div>
    <div class="meta"><span class="float">${esc(it.float)}</span><span>${esc(it.rarity)}</span></div>
    ${it.special ? `<span class="badge">${esc(it.special)}</span>` : ""}
  </div>`;
}

function showModal(html, onClose) {
  const m = $("#modal");
  m.innerHTML = `<div class="box"><button class="ghost close">Close</button>${html}</div>`;
  m.hidden = false;
  const close = () => { m.hidden = true; m.innerHTML = ""; if (onClose) onClose(); };
  m.querySelector(".close").onclick = close;
  m.onclick = (e) => { if (e.target === m) close(); };
  return m;
}

// ---------- cases ----------
async function viewCases() {
  const cases = await api("/cases");
  $("#app").innerHTML = `<h2>Cases</h2><div class="grid">${cases.map((c) => `
    <div class="card case" data-id="${c.id}">
      <img src="${esc(c.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">
      <div class="name">${esc(c.name)}</div>
      <div class="coins">${fmt(c.price)}</div>
      <div class="muted">${c.skin_count} skins</div>
      ${c.owned > 0 ? `<div class="owned">You own ${c.owned} (free open)</div>` : ""}
    </div>`).join("")}</div>`;
  document.querySelectorAll(".case").forEach((el) => (el.onclick = guard(() => openCaseModal(Number(el.dataset.id)))));
}

async function openCaseModal(id) {
  const c = await api("/cases/" + id);
  const owned = (await api("/cases")).find((x) => x.id === id).owned;
  const m = showModal(`
    <h2>${esc(c.name)}</h2>
    <div class="roulette" id="roulette" hidden><div class="strip" id="strip"></div><div class="pointer"></div></div>
    <div id="result"></div>
    <div class="toolbar"><button class="primary" id="openBtn"></button><span class="muted" id="openHint"></span></div>
    <h3>Contents &amp; drop chances</h3>
    <div class="tiles">${c.skins.map((s) => `
      <div class="tile" style="--c:${esc(s.color)}"><img src="${esc(s.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">
        <div>${esc(s.name)}</div><div class="muted">${esc(s.rarity_name)} · ${pct(s.chance)}</div></div>`).join("")}</div>`,
    () => { if (currentTab === "cases") viewCases().catch(() => {}); });

  const btn = $("#openBtn", m);
  const label = () => {
    const free = (m._owned ?? owned) > 0;
    btn.textContent = free ? "Open (free, you own " + (m._owned ?? owned) + ")" : "Open for " + fmt(c.price);
  };
  m._owned = owned; label();
  $("#openHint", m).textContent = "Your balance: " + fmt(me.balance);

  btn.onclick = guard(async () => {
    btn.disabled = true;
    $("#result", m).innerHTML = "";
    let res;
    try { res = await api("/cases/" + id + "/open", { method: "POST" }); }
    catch (e) { btn.disabled = false; throw e; }
    if (res.free_open) m._owned = Math.max(0, m._owned - 1);
    setBalance(res.balance);
    await spin(m, c.skins, res.item);
    $("#openHint", m).textContent = "Your balance: " + fmt(res.balance);
    label();
    btn.disabled = false;
  });
}

// Visual roulette. The result is ALREADY decided by the server; this is only an animation.
function spin(modal, skins, won) {
  return new Promise((resolve) => {
    const CELL = 150, WIN_INDEX = 38, TOTAL = 46;
    const pickRandom = () => {
      let r = Math.random(), acc = 0;
      for (const s of skins) { acc += s.chance; if (r <= acc) return s; }
      return skins[skins.length - 1];
    };
    const cells = Array.from({ length: TOTAL }, (_, i) => (i === WIN_INDEX ? { name: won.name, image_url: won.image_url, color: won.color } : { name: "", ...pickRandom() }));
    const roulette = $("#roulette", modal), strip = $("#strip", modal);
    strip.style.transition = "none";
    strip.style.transform = "translateX(0)";
    strip.innerHTML = cells.map((s) => `<div class="cell" style="--c:${esc(s.color)}"><img src="${esc(s.image_url)}" alt="" referrerpolicy="no-referrer"><span>${esc(s.name)}</span></div>`).join("");
    roulette.hidden = false;
    void strip.offsetWidth; // force reflow so the transition restarts
    const jitter = Math.floor(Math.random() * 100) - 50;
    const target = WIN_INDEX * CELL + CELL / 2 + jitter - roulette.clientWidth / 2;
    strip.style.transition = "transform 6s cubic-bezier(.12,.7,.1,1)";
    strip.style.transform = `translateX(${-target}px)`;
    setTimeout(() => {
      $("#result", modal).innerHTML = `<div class="result" style="--c:${esc(won.color)}">
        <img src="${esc(won.image_url)}" alt="" referrerpolicy="no-referrer">
        <h3>${esc(won.name)}</h3>
        <div>${esc(won.rarity)} · ${esc(won.wear)} · float <span class="float">${esc(won.float)}</span></div>
        ${won.special ? `<span class="badge">${esc(won.special)}</span>` : ""}
        <div class="coins" style="margin-top:6px">Worth ${fmt(won.price)}</div></div>`;
      resolve();
    }, 6200);
  });
}

// ---------- inventory ----------
const SORTS = {
  new: ["Newest", () => 0],
  price: ["Price (high first)", (a, b) => b.price - a.price],
  floatLow: ["Float (lowest first)", (a, b) => Number(a.float) - Number(b.float)],
  rarity: ["Rarity (high first)", (a, b) => b.rarity_tier - a.rarity_tier || b.price - a.price],
};

async function viewInventory() {
  const items = await api("/inventory");
  const selected = new Set();
  let sort = "new";
  const root = $("#app");
  const draw = () => {
    const list = [...items].sort(SORTS[sort][1]);
    const total = items.filter((i) => selected.has(i.id)).reduce((s, i) => s + i.price, 0);
    root.innerHTML = `<h2>Inventory <span class="muted">(${items.length} items, worth ${fmt(items.reduce((s, i) => s + i.price, 0))})</span></h2>
      <div class="toolbar">
        <select id="sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${k === sort ? "selected" : ""}>${v[0]}</option>`).join("")}</select>
        <button class="ghost" id="selAll">Select all</button><button class="ghost" id="selNone">Clear</button>
        <span class="spacer"></span>
        <span class="muted">${selected.size} selected · ${fmt(total)} coins</span>
        <button class="primary" id="sell" ${selected.size ? "" : "disabled"}>Sell selected</button>
      </div>
      ${items.length ? `<div class="grid">${list.map((i) => itemCard(i, selected.has(i.id))).join("")}</div>` : `<p class="muted">Empty. Open some cases!</p>`}`;
    $("#sort").onchange = (e) => { sort = e.target.value; draw(); };
    $("#selAll").onclick = () => { items.forEach((i) => selected.add(i.id)); draw(); };
    $("#selNone").onclick = () => { selected.clear(); draw(); };
    root.querySelectorAll(".item").forEach((el) => (el.onclick = () => { const id = Number(el.dataset.id); selected.has(id) ? selected.delete(id) : selected.add(id); draw(); }));
    $("#sell").onclick = guard(async () => {
      const res = await api("/inventory/sell", { method: "POST", body: { ids: [...selected] } });
      setBalance(res.balance);
      toast(`Sold ${res.sold} item(s) for ${fmt(res.earned)} coins`);
      viewInventory();
    });
  };
  draw();
}

// ---------- contracts ----------
async function viewContracts() {
  const items = await api("/inventory");
  const selected = new Set();
  const root = $("#app");
  let previewHtml = "";
  let tierFilter = "all";

  const tiers = [...new Map(items.map((i) => [i.rarity_tier, i.rarity])).entries()].sort((a, b) => a[0] - b[0]);
  const draw = () => {
    const shown = items.filter((i) => tierFilter === "all" || String(i.rarity_tier) === tierFilter);
    root.innerHTML = `<h2>Trade-up contract</h2>
      <p class="muted">Put exactly 10 items of the same rarity in. You get 1 item of the next rarity from a case your items came from.
      The new item's float is the <b>average</b> of your inputs (as a share of each skin's float range), so you can aim for a special float — like exactly 0.5.</p>
      <div class="toolbar">
        <select id="tier"><option value="all">All rarities</option>${tiers.map(([t, n]) => `<option value="${t}" ${String(t) === tierFilter ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
        <span class="spacer"></span>
        <span class="coins" style="color:var(--text)">${selected.size} / 10 selected</span>
        <button class="ghost" id="clear">Clear</button>
        <button class="primary" id="sign" ${selected.size === 10 ? "" : "disabled"}>Sign contract</button>
      </div>
      <div id="preview">${previewHtml}</div>
      ${shown.length ? `<div class="grid">${shown.map((i) => itemCard(i, selected.has(i.id))).join("")}</div>` : `<p class="muted">No items.</p>`}`;
    $("#tier").onchange = (e) => { tierFilter = e.target.value; draw(); };
    $("#clear").onclick = () => { selected.clear(); previewHtml = ""; draw(); };
    root.querySelectorAll(".item").forEach((el) => (el.onclick = () => {
      const id = Number(el.dataset.id);
      if (selected.has(id)) selected.delete(id);
      else if (selected.size < 10) selected.add(id);
      refreshPreview();
    }));
    $("#sign").onclick = guard(async () => {
      const res = await api("/contracts", { method: "POST", body: { ids: [...selected] } });
      const it = res.item;
      showModal(`<h2>Contract result</h2><div class="result" style="--c:${esc(it.color)}">
        <img src="${esc(it.image_url)}" alt="" referrerpolicy="no-referrer"><h3>${esc(it.name)}</h3>
        <div>${esc(it.rarity)} · ${esc(it.wear)} · float <span class="float">${esc(it.float)}</span></div>
        ${it.special ? `<span class="badge">${esc(it.special)}</span>` : ""}
        <div class="coins" style="margin-top:6px">Worth ${fmt(it.price)}</div></div>`, () => viewContracts());
    });
  };
  async function refreshPreview() {
    previewHtml = "";
    if (selected.size === 10) {
      try {
        const out = await api("/contracts/preview", { method: "POST", body: { ids: [...selected] } });
        previewHtml = `<div class="card" style="margin-bottom:14px"><b>Possible results</b>
          <table><tr><th>Item</th><th class="num">Chance</th><th class="num">Float</th><th>Wear</th><th class="num">Price</th></tr>
          ${out.map((o) => `<tr><td style="border-left:3px solid ${esc(o.color)}">${esc(o.name)} ${o.special ? `<span class="badge">${esc(o.special)}</span>` : ""}</td>
            <td class="num">${pct(o.chance)}</td><td class="num float">${esc(o.float)}</td><td>${esc(o.wear)}</td><td class="num">${fmt(o.price)}</td></tr>`).join("")}</table></div>`;
      } catch (e) { previewHtml = `<div class="error">${esc(e.message)}</div>`; }
    }
    draw();
  }
  draw();
}

// ---------- leaderboard / history ----------
async function viewLeaderboard() {
  const lb = await api("/leaderboard");
  $("#app").innerHTML = `<div class="two">
    <div class="card"><h2>Cleanest floats</h2><table><tr><th>#</th><th>Item</th><th>Owner</th><th class="num">Float</th></tr>
      ${lb.cleanest.map((r, i) => `<tr><td>${i + 1}</td><td style="border-left:3px solid ${esc(r.color)}">${esc(r.name)}</td><td>${esc(r.nick)}</td><td class="num float">${esc(r.float)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">Nothing yet</td></tr>`}</table></div>
    <div class="card"><h2>Richest players</h2><table><tr><th>#</th><th>Player</th><th class="num">Coins</th><th class="num">Items</th></tr>
      ${lb.richest.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.nick)}</td><td class="num">${fmt(r.balance)}</td><td class="num">${r.items}</td></tr>`).join("")}</table></div></div>`;
}

async function viewHistory() {
  const rows = await api("/transactions");
  $("#app").innerHTML = `<h2>Last transactions</h2><div class="card"><table><tr><th>When</th><th>Type</th><th>Note</th><th class="num">Coins</th></tr>
    ${rows.map((r) => `<tr><td>${new Date(r.created_at).toLocaleString()}</td><td>${esc(r.kind)}</td><td>${esc(r.note || "")}</td>
      <td class="num" style="color:${r.amount < 0 ? "var(--bad)" : r.amount > 0 ? "var(--good)" : "inherit"}">${r.amount > 0 ? "+" : ""}${fmt(r.amount)}</td></tr>`).join("")}</table></div>`;
}

// ---------- admin ----------
async function viewAdmin() {
  const [users, skins, cases] = await Promise.all([api("/admin/users"), api("/admin/skins"), api("/cases")]);
  const nickList = `<datalist id="nicks">${users.map((u) => `<option value="${esc(u.nick)}">`).join("")}</datalist>`;
  $("#app").innerHTML = `<h2>Admin panel</h2>${nickList}
    <div class="two">
      <div class="card"><h3 style="margin-top:0">Give / take coins</h3>
        <form data-act="money"><label>Player nick</label><input name="nick" list="nicks" required>
        <label>Amount (negative = take away)</label><input name="amount" type="number" step="1" required>
        <button class="primary" style="margin-top:12px">Apply</button></form></div>
      <div class="card"><h3 style="margin-top:0">Give cases</h3>
        <form data-act="case"><label>Player nick</label><input name="nick" list="nicks" required>
        <label>Case</label><select name="caseId">${cases.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
        <label>Quantity</label><input name="qty" type="number" min="1" max="1000" value="1" required>
        <button class="primary" style="margin-top:12px">Give</button></form></div>
      <div class="card"><h3 style="margin-top:0">Give a skin</h3>
        <form data-act="skin"><label>Player nick</label><input name="nick" list="nicks" required>
        <label>Skin</label><select name="skinId">${skins.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.rarity)})</option>`).join("")}</select>
        <label>Float (optional, empty = random; e.g. 0.5)</label><input name="float" placeholder="random">
        <button class="primary" style="margin-top:12px">Give</button></form></div>
      <div class="card"><h3 style="margin-top:0">Players</h3><table><tr><th>Nick</th><th class="num">Coins</th><th class="num">Items</th><th class="num">Cases</th></tr>
        ${users.map((u) => `<tr><td>${esc(u.nick)}${u.is_admin ? " ★" : ""}</td><td class="num">${fmt(u.balance)}</td><td class="num">${u.items}</td><td class="num">${u.cases}</td></tr>`).join("")}</table></div>
    </div>`;
  document.querySelectorAll("form[data-act]").forEach((f) => (f.onsubmit = guard(async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    if (d.amount !== undefined) d.amount = Number(d.amount);
    if (d.qty !== undefined) d.qty = Number(d.qty);
    if (d.float === "") delete d.float;
    const out = await api("/admin/" + f.dataset.act, { method: "POST", body: d });
    toast("Done: " + JSON.stringify(out));
    if (out.nick && out.nick.toLowerCase() === me.nick.toLowerCase() && out.balance !== undefined) setBalance(out.balance);
    viewAdmin();
  })));
}

// ---------- start ----------
async function boot() {
  if (!token) return renderAuth();
  try {
    me = await api("/me");
    renderShell();
  } catch (e) {
    if (!token) return;
    toast(e.message, "err");
    renderAuth();
  }
}
boot();
