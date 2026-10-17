"use strict";

const PREFS_KEY = "cc.prefs";
const RATES_KEY = "cc.rates";
const CURRENCIES_KEY = "cc.currencies";
const FALLBACK_DEFAULTS = ["USD", "EUR", "GBP", "JPY", "CNY", "HKD"];

const $ = (sel) => document.querySelector(sel);
const listEl = $("#currency-list");
const statusEl = $("#status");
const sourceEl = $("#source");
const editBtn = $("#edit-btn");
const themeSelect = $("#theme-select");
const picker = $("#picker");
const pickerList = $("#picker-list");
const pickerSearch = $("#picker-search");
const rowTemplate = $("#row-template");
const refreshBtn = $("#refresh-btn");
const ptrEl = $("#ptr");

let currencies = {};       // code -> name
let ratesData = null;      // last /api/rates payload
let editing = false;
let refreshTimer = null;
let inflight = null;
let prefs = loadJSON(PREFS_KEY, {});

// ---------- storage ----------

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or disabled: preferences just won't persist */
  }
}

function savePrefs() {
  saveJSON(PREFS_KEY, prefs);
}

// ---------- formatting ----------

const digitsCache = {};
function currencyDigits(code) {
  if (!(code in digitsCache)) {
    try {
      digitsCache[code] = new Intl.NumberFormat("en-US", { style: "currency", currency: code })
        .resolvedOptions().maximumFractionDigits;
    } catch {
      digitsCache[code] = 2;
    }
  }
  return digitsCache[code];
}

function formatAmount(value, code) {
  if (value == null || !isFinite(value)) return "";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  const opts = abs < 1
    ? { maximumSignificantDigits: 4 }
    : { minimumFractionDigits: currencyDigits(code), maximumFractionDigits: currencyDigits(code) };
  return new Intl.NumberFormat("en-US", opts).format(value);
}

function formatRate(value) {
  if (!isFinite(value)) return "—";
  const abs = Math.abs(value);
  const opts = abs >= 100 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 5 };
  return new Intl.NumberFormat("en-US", opts).format(value);
}

function parseAmount(text) {
  const cleaned = text.replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
}

function flagFor(code) {
  const cc = code.slice(0, 2).toUpperCase();
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function timeAgo(date) {
  const secs = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  return date.toLocaleString();
}

// ---------- conversion ----------

function rate(code) {
  return ratesData && ratesData.rates ? ratesData.rates[code] : undefined;
}

function convert(amount, from, to) {
  const rf = rate(from);
  const rt = rate(to);
  if (amount == null || !rf || !rt) return null;
  return (amount * rt) / rf;
}

// ---------- rendering ----------

function renderList() {
  listEl.classList.toggle("editing", editing);
  listEl.replaceChildren();

  if (prefs.currencies.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No currencies selected. Add one below.";
    listEl.append(li);
    return;
  }

  prefs.currencies.forEach((code, idx) => {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.code = code;
    row.querySelector(".flag").textContent = flagFor(code);
    row.querySelector(".code").textContent = code;
    row.querySelector(".name").textContent = currencies[code] || code;

    const input = row.querySelector(".amount");
    input.setAttribute("aria-label", `Amount in ${code}`);
    input.addEventListener("input", () => onAmountInput(code, input));
    input.addEventListener("focus", () => input.select());
    input.addEventListener("blur", () => updateValues());

    const up = row.querySelector(".up");
    const down = row.querySelector(".down");
    up.disabled = idx === 0;
    down.disabled = idx === prefs.currencies.length - 1;
    up.addEventListener("click", () => moveCurrency(idx, -1));
    down.addEventListener("click", () => moveCurrency(idx, 1));
    row.querySelector(".remove").addEventListener("click", () => removeCurrency(code));

    listEl.append(row);
  });

  updateValues();
}

function updateValues() {
  const base = prefs.baseCode;
  const amount = prefs.baseAmount;
  for (const row of listEl.querySelectorAll(".row")) {
    const code = row.dataset.code;
    const input = row.querySelector(".amount");
    const hint = row.querySelector(".hint");
    const available = rate(code) != null;
    row.classList.toggle("active", code === base);
    input.disabled = !available && ratesData != null;

    if (!available) {
      if (document.activeElement !== input) input.value = "";
      input.placeholder = ratesData ? "unavailable" : "…";
      hint.textContent = "";
      continue;
    }
    input.placeholder = "0";

    if (document.activeElement !== input) {
      const value = code === base ? amount : convert(amount, base, code);
      input.value = formatAmount(value, code);
    }

    if (code === base || rate(base) == null) {
      hint.textContent = " ";
    } else {
      hint.textContent = `1 ${base} = ${formatRate(convert(1, base, code))} ${code}`;
    }
  }
}

function renderStatus() {
  if (!ratesData) {
    statusEl.textContent = navigator.onLine ? "Loading rates…" : "Offline — no cached rates yet";
    statusEl.classList.toggle("warn", !navigator.onLine);
    return;
  }
  const updated = new Date(ratesData.updated_at);
  const stale = ratesData.stale || Date.now() > new Date(ratesData.expires_at).getTime() + 60_000;
  const offline = !navigator.onLine || ratesData._offline;
  let text = `Updated ${timeAgo(updated)}`;
  if (offline) text = `Offline · rates from ${updated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  else if (stale) text += " · may be out of date";
  statusEl.textContent = text;
  statusEl.classList.toggle("warn", offline || stale);
  statusEl.title = `Rates updated ${updated.toLocaleString()}`;

  const used = new Set(prefs.currencies.map((c) => ratesData.sources?.[c]).filter((s) => s && s !== "fixed"));
  sourceEl.textContent = used.size
    ? `Rates via ${[...used].map(sourceLabel).join(", ")} · refreshed every ${Math.round(ratesData.ttl / 60)} min`
    : "";
}

function sourceLabel(s) {
  return { yahoo: "Yahoo Finance", "open.er-api": "ExchangeRate-API", stale: "cache" }[s] || s;
}

// ---------- actions ----------

function onAmountInput(code, input) {
  prefs.baseCode = code;
  prefs.baseAmount = parseAmount(input.value);
  savePrefs();
  updateValues();
}

function moveCurrency(idx, delta) {
  const list = prefs.currencies;
  const target = idx + delta;
  if (target < 0 || target >= list.length) return;
  [list[idx], list[target]] = [list[target], list[idx]];
  savePrefs();
  renderList();
}

function addCurrency(code) {
  if (prefs.currencies.includes(code)) return;
  prefs.currencies.push(code);
  if (!prefs.currencies.includes(prefs.baseCode)) prefs.baseCode = code;
  savePrefs();
  renderList();
  renderStatus();
}

function removeCurrency(code) {
  prefs.currencies = prefs.currencies.filter((c) => c !== code);
  if (prefs.baseCode === code && prefs.currencies.length) {
    // Keep the displayed amount by re-basing onto another visible currency.
    const next = prefs.currencies[0];
    prefs.baseAmount = convert(prefs.baseAmount, code, next);
    prefs.baseCode = next;
  }
  savePrefs();
  renderList();
  renderStatus();
}

function setEditing(on) {
  editing = on;
  editBtn.setAttribute("aria-pressed", String(on));
  editBtn.textContent = on ? "Done" : "Edit";
  listEl.classList.toggle("editing", on);
}

// ---------- picker ----------

function renderPicker() {
  const q = pickerSearch.value.trim().toLowerCase();
  pickerList.replaceChildren();
  for (const [code, name] of Object.entries(currencies)) {
    if (q && !code.toLowerCase().includes(q) && !name.toLowerCase().includes(q)) continue;
    const li = document.createElement("li");
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = prefs.currencies.includes(code);
    cb.addEventListener("change", () => (cb.checked ? addCurrency(code) : removeCurrency(code)));
    const flag = document.createElement("span");
    flag.className = "flag";
    flag.textContent = flagFor(code);
    const nameEl = document.createElement("span");
    nameEl.textContent = name;
    const codeEl = document.createElement("span");
    codeEl.className = "code";
    codeEl.textContent = code;
    label.append(cb, flag, nameEl, codeEl);
    li.append(label);
    pickerList.append(li);
  }
}

function openPicker() {
  pickerSearch.value = "";
  renderPicker();
  picker.showModal();
  pickerSearch.focus();
}

// ---------- theme ----------

const darkQuery = matchMedia("(prefers-color-scheme: dark)");

function applyTheme() {
  const choice = prefs.theme || "system";
  const theme = choice === "system" ? (darkQuery.matches ? "dark" : "light") : choice;
  document.documentElement.dataset.theme = theme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]').setAttribute("content", bg);
  themeSelect.value = choice;
}

// ---------- data loading ----------

async function loadCurrencies() {
  try {
    const res = await fetch("/api/currencies");
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    saveJSON(CURRENCIES_KEY, data);
    return data;
  } catch {
    return loadJSON(CURRENCIES_KEY, null);
  }
}

function scheduleRefresh(ms) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshRates, ms);
}

// Always asks the server (which has its own cache); concurrent calls share one request.
function refreshRates() {
  if (!inflight) {
    refreshBtn.classList.add("spinning");
    inflight = fetchRates().finally(() => {
      inflight = null;
      refreshBtn.classList.remove("spinning");
    });
  }
  return inflight;
}

async function fetchRates() {
  try {
    const res = await fetch("/api/rates", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ratesData = await res.json();
    saveJSON(RATES_KEY, ratesData);
    // The server refreshes before expiry, so new rates are ready by expires_at.
    const untilExpiry = new Date(ratesData.expires_at).getTime() - Date.now();
    scheduleRefresh(Math.max(15_000, untilExpiry + 2_000));
  } catch (err) {
    console.warn("Failed to load rates", err);
    if (!ratesData) {
      const cached = loadJSON(RATES_KEY, null);
      if (cached) ratesData = cached;
    }
    if (ratesData) ratesData._offline = true;
    scheduleRefresh(30_000);
  }
  updateValues();
  renderStatus();
}

// ---------- pull to refresh ----------

const PULL_THRESHOLD = 70; // px of indicator travel needed to trigger
const PULL_MAX = 110;

function setPull(px, animate = false) {
  ptrEl.classList.toggle("animating", animate);
  ptrEl.classList.toggle("ready", px >= PULL_THRESHOLD);
  ptrEl.style.transform = `translate(-50%, ${px - 48}px)`;
  ptrEl.style.opacity = String(Math.min(1, px / PULL_THRESHOLD));
  ptrEl.querySelector(".ptr-icon").style.transform = ptrEl.classList.contains("refreshing") ? "" : `rotate(${px * 3}deg)`;
}

function setupPullToRefresh() {
  let startY = null;
  let pull = 0;

  window.addEventListener("touchstart", (e) => {
    if (window.scrollY > 0 || picker.open || e.touches.length !== 1 || ptrEl.classList.contains("refreshing")) return;
    startY = e.touches[0].clientY;
    pull = 0;
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) {
      pull = 0;
      setPull(0);
      return;
    }
    pull = Math.min(PULL_MAX, dy * 0.5); // resistance
    setPull(pull);
  }, { passive: true });

  const end = async () => {
    if (startY === null) return;
    startY = null;
    if (pull < PULL_THRESHOLD) {
      setPull(0, true);
      return;
    }
    ptrEl.classList.add("refreshing");
    setPull(PULL_THRESHOLD, true);
    // Keep the spinner visible briefly so the refresh is noticeable even when the server is fast.
    await Promise.all([refreshRates(), new Promise((r) => setTimeout(r, 500))]);
    ptrEl.classList.remove("refreshing");
    setPull(0, true);
  };
  window.addEventListener("touchend", end);
  window.addEventListener("touchcancel", end);
}

// ---------- init ----------

async function init() {
  applyTheme();

  ratesData = loadJSON(RATES_KEY, null); // show cached rates instantly
  const meta = await loadCurrencies();
  if (meta) {
    currencies = Object.fromEntries(meta.currencies.map((c) => [c.code, c.name]));
  } else {
    // First run while offline: fall back to whatever codes we have rates for.
    currencies = Object.fromEntries(Object.keys(ratesData?.rates || {}).map((c) => [c, c]));
  }

  if (!Array.isArray(prefs.currencies)) {
    prefs.currencies = (meta?.defaults || FALLBACK_DEFAULTS).filter((c) => c in currencies);
  }
  prefs.currencies = prefs.currencies.filter((c) => c in currencies);
  if (!prefs.currencies.includes(prefs.baseCode)) prefs.baseCode = prefs.currencies[0];
  if (prefs.baseAmount === undefined) prefs.baseAmount = 100;
  savePrefs();

  renderList();
  renderStatus();
  refreshRates();

  editBtn.addEventListener("click", () => setEditing(!editing));
  $("#add-btn").addEventListener("click", openPicker);
  pickerSearch.addEventListener("input", renderPicker);
  themeSelect.addEventListener("change", () => {
    prefs.theme = themeSelect.value;
    savePrefs();
    applyTheme();
  });
  darkQuery.addEventListener("change", applyTheme);

  // Re-fetch whenever the app comes back to the foreground or is restored from the back/forward cache.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshRates();
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) refreshRates();
  });
  window.addEventListener("online", refreshRates);
  refreshBtn.addEventListener("click", refreshRates);
  setupPullToRefresh();
  window.addEventListener("offline", renderStatus);
  setInterval(renderStatus, 30_000);

  // Pick up preference changes made in another tab.
  window.addEventListener("storage", (e) => {
    if (e.key === PREFS_KEY && e.newValue) {
      prefs = JSON.parse(e.newValue);
      applyTheme();
      renderList();
      renderStatus();
    }
  });
}

// ---------- PWA ----------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("SW registration failed", err));
  });
}

let deferredInstall = null;
const installBtn = $("#install-btn");
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  installBtn.hidden = false;
});
installBtn.addEventListener("click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  installBtn.hidden = true;
});
window.addEventListener("appinstalled", () => (installBtn.hidden = true));

init();
