"use strict";
// All URLs are relative so the app works both at "/" and under a sub-path like "/fx/".

const PREFS_KEY = "cc.prefs";
const RATES_KEY = "cc.rates";
const CURRENCIES_KEY = "cc.currencies";
const FALLBACK_DEFAULTS = ["USD", "EUR", "GBP", "JPY", "CNY", "HKD"];

const $ = (sel) => document.querySelector(sel);
const listEl = $("#currency-list");
const statusEl = $("#status");
const editBtn = $("#edit-btn");
const themeSelect = $("#theme-select");
const langSelect = $("#lang-select");
const t = I18n.t;
const picker = $("#picker");
const pickerList = $("#picker-list");
const pickerSearch = $("#picker-search");
const rowTemplate = $("#row-template");
const refreshBtn = $("#refresh-btn");
const keypad = $("#keypad");
const keypadTarget = $("#keypad-target");
const keypadPreview = $("#keypad-preview");
const ptrEl = $("#ptr");
const chartDialog = $("#chart");
const toastEl = $("#toast");

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

function flagFor(code) {
  const cc = code.slice(0, 2).toUpperCase();
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function timeAgo(date) {
  const secs = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (secs < 60) return t("justNow");
  const mins = Math.round(secs / 60);
  if (mins < 60) return t("minAgo", { n: mins });
  return date.toLocaleString(I18n.lang);
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
    li.textContent = t("empty");
    listEl.append(li);
    return;
  }

  prefs.currencies.forEach((code, idx) => {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.code = code;
    row.querySelector(".flag").textContent = flagFor(code);
    row.querySelector(".code").textContent = code;
    row.querySelector(".name").textContent = I18n.currencyName(code, currencies[code]);
    I18n.apply(row);

    const input = row.querySelector(".amount");
    input.setAttribute("aria-label", t("amountIn", { code }));
    input.addEventListener("input", () => onAmountInput(code, input));
    input.addEventListener("focus", () => onAmountFocus(input));
    input.addEventListener("blur", onAmountBlur);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "=") {
        e.preventDefault();
        commitAmount(code, input);
      }
    });

    setupReorder(row.querySelector(".handle"), row, idx);
    row.querySelector(".remove").addEventListener("click", () => removeCurrency(code));
    // Tapping anywhere on a row edits its amount.
    row.addEventListener("click", (e) => {
      // The flag and name open the rate chart (base -> this currency); the base row has no pair to chart.
      if (!editing && code !== prefs.baseCode && e.target.closest(".flag, .meta")) {
        openChart(prefs.baseCode, code);
        return;
      }
      if (editing || input.disabled || e.target === input || e.target.closest(".edit-controls")) return;
      input.focus();
    });

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
      input.placeholder = ratesData ? t("unavailable") : "…";
      hint.textContent = "";
      continue;
    }
    input.placeholder = "0";

    if (document.activeElement !== input) {
      const value = code === base ? amount : convert(amount, base, code);
      input.value = formatAmount(value, code);
    }

    if (code === base) {
      // While typing a calculation, preview its result under the field.
      const typing = document.activeElement === input && Calc.isExpression(input.value);
      hint.textContent = typing && amount != null ? `= ${formatAmount(amount, code)}` : "\u00a0";
    } else if (rate(base) == null) {
      hint.textContent = "\u00a0";
    } else {
      hint.textContent = `1 ${base} = ${formatRate(convert(1, base, code))} ${code}`;
    }
  }
  updateKeypadHead();
}

function renderStatus() {
  if (!ratesData) {
    statusEl.textContent = navigator.onLine ? t("loadingRates") : t("offlineNoCache");
    statusEl.classList.toggle("warn", !navigator.onLine);
    return;
  }
  const updated = new Date(ratesData.updated_at);
  const stale = ratesData.stale || Date.now() > new Date(ratesData.expires_at).getTime() + 60_000;
  const offline = !navigator.onLine || ratesData._offline;
  let text = t("updated", { when: timeAgo(updated) });
  if (offline) text = t("offlineFrom", { time: updated.toLocaleTimeString(I18n.lang, { hour: "2-digit", minute: "2-digit" }) });
  else if (stale) text += ` · ${t("mayBeOld")}`;
  statusEl.textContent = text;
  statusEl.classList.toggle("warn", offline || stale);
  statusEl.title = t("ratesUpdatedAt", { when: updated.toLocaleString(I18n.lang) });
}

// ---------- actions ----------

function onAmountInput(code, input) {
  prefs.baseCode = code;
  prefs.baseAmount = Calc.evaluatePartial(input.value);
  savePrefs();
  updateValues();
}

// Replace a typed calculation with its result, keeping focus so the user can continue.
// The result is selected, so typing a digit starts a new number and an operator continues it.
function commitAmount(code, input) {
  if (prefs.baseCode !== code) onAmountInput(code, input);
  input.value = formatAmount(prefs.baseAmount, code);
  input.select();
  updateValues();
}

// ---------- calculator keypad ----------

// Amounts are always entered with this keypad (inputmode="none" keeps the device keyboard closed);
// a physical keyboard still works on desktop.
let activeInput = null;  // the amount field being edited

function showKeypad() {
  keypad.hidden = false;
  document.body.classList.add("keypad-open");
  document.body.style.setProperty("--keypad-h", `${keypad.offsetHeight}px`);
  updateKeypadHead();
  requestAnimationFrame(() => {
    // Keep the row being edited visible above the keypad.
    const row = activeInput && activeInput.closest(".row");
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const limit = window.innerHeight - keypad.offsetHeight - 8;
    if (rect.bottom > limit) window.scrollBy({ top: rect.bottom - limit, behavior: "smooth" });
    else if (rect.top < 8) window.scrollBy({ top: rect.top - 8, behavior: "smooth" });
  });
}

function hideKeypad() {
  keypad.hidden = true;
  document.body.classList.remove("keypad-open");
}

function updateKeypadHead() {
  if (!activeInput || keypad.hidden) return;
  const code = activeInput.closest(".row").dataset.code;
  keypadTarget.textContent = `${flagFor(code)} ${code}`;
  const showResult = Calc.isExpression(activeInput.value) && prefs.baseAmount != null;
  keypadPreview.textContent = showResult ? `= ${formatAmount(prefs.baseAmount, code)}` : "";
}

function onAmountFocus(input) {
  if (Date.now() - lastLongPress < 800) { // the press copied the value; don't also start editing
    input.blur();
    return;
  }
  activeInput = input;
  input.select();
  showKeypad();
}

function onAmountBlur(e) {
  // Never let the keypad steal focus from the field it is typing into.
  if (e.relatedTarget && keypad.contains(e.relatedTarget)) {
    e.target.focus({ preventScroll: true });
    return;
  }
  // Focus may be moving to another amount field; keep the keypad open in that case.
  setTimeout(() => {
    if (document.activeElement && document.activeElement.classList.contains("amount")) return;
    activeInput = null;
    hideKeypad();
    updateValues(); // re-format, which also commits a calculation to its result
  }, 0);
}

// Ends editing immediately (commits the value, closes the keypad). Unlike the blur handler this
// does not wait for a timer, which matters when the app is being sent to the background:
// mobile browsers pause timers there, which used to leave the keypad open on return.
function stopEditing() {
  const input = activeInput;
  activeInput = null;
  hideKeypad();
  if (input && document.activeElement === input) input.blur();
  updateValues();
}

function insertIntoAmount(input, text) {
  let start = input.selectionStart ?? input.value.length;
  let end = input.selectionEnd ?? input.value.length;
  // When the whole value is selected (on focus, after "="), an operator extends it instead of replacing it.
  if ("+−×÷".includes(text) && input.value && start === 0 && end === input.value.length) {
    start = end = input.value.length;
  }
  input.setRangeText(text, start, end, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function backspaceAmount(input) {
  let start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  if (start === end) {
    if (start === 0) return;
    start -= 1;
  }
  input.setRangeText("", start, end, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressKey(btn) {
  const input = activeInput;
  if (!input || !input.isConnected) {
    stopEditing(); // a keypad without a field to type into should not be on screen
    return;
  }
  const { insert, action } = btn.dataset;
  if (action === "done") {
    stopEditing();
    return;
  }
  // Focus can be lost behind our back (e.g. app switching); refocus the field shown in the header.
  // Like tapping it, that selects the value: a digit starts a new number, an operator continues it.
  if (document.activeElement !== input) input.focus({ preventScroll: true });
  const code = input.closest(".row").dataset.code;
  if (insert) insertIntoAmount(input, insert);
  else if (action === "backspace") backspaceAmount(input);
  else if (action === "clear") {
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (action === "equals") commitAmount(code, input);
}

function setupKeypad() {
  // Act on press, like a hardware keypad. preventDefault stops the browser from moving
  // focus to the button, so the amount field (and its caret) stays active.
  let pressedByPointer = false;
  keypad.addEventListener("pointerdown", (e) => {
    e.preventDefault(); // also for taps between keys, which would otherwise close the keypad
    const btn = e.target.closest("button");
    // "Done" closes the keypad, so it waits for the release (click). Acting on press would
    // hide the keypad mid-tap and let the release land on the row underneath, focusing it.
    if (!btn || btn.dataset.action === "done") return;
    pressedByPointer = true;
    pressKey(btn);
  });
  // Handles "Done", plus keyboard / screen-reader activation (a click without a pointer press).
  keypad.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (pressedByPointer && !(btn && btn.dataset.action === "done")) {
      pressedByPointer = false;
      return;
    }
    pressedByPointer = false;
    if (btn) pressKey(btn);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && activeInput) stopEditing();
  });
}

// Drag a row by its handle (pointer events, so it works with touch and mouse); arrow keys on the
// focused handle move it one step. The row follows the pointer and the others shift out of its way.
function setupReorder(handle, row, idx) {
  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    moveCurrency(idx, e.key === "ArrowUp" ? -1 : 1);
    listEl.querySelectorAll(".handle")[Math.max(0, Math.min(prefs.currencies.length - 1, idx + (e.key === "ArrowUp" ? -1 : 1)))]?.focus();
  });

  handle.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    // The DOM is left untouched while dragging (re-parenting the row would drop the pointer capture
    // and freeze a fast drag); rows are only shifted with transforms and re-rendered on release.
    const rows = [...listEl.querySelectorAll(".row")];
    const from = rows.indexOf(row);
    const tops = rows.map((r) => r.getBoundingClientRect().top);
    const step = rows.length > 1 ? tops[1] - tops[0] : row.offsetHeight; // row height incl. border
    const startY = e.clientY;
    let target = from;
    row.classList.add("dragging");
    rows.forEach((r) => r !== row && r.classList.add("shifting"));

    const onMove = (ev) => {
      // Keep the dragged row inside the list, however fast the pointer moves.
      const dy = Math.max(-from * step, Math.min((rows.length - 1 - from) * step, ev.clientY - startY));
      row.style.transform = `translateY(${dy}px)`;
      target = Math.max(0, Math.min(rows.length - 1, Math.round(from + dy / step)));
      rows.forEach((r, i) => {
        if (r === row) return;
        const shift = from < target && i > from && i <= target ? -step : from > target && i >= target && i < from ? step : 0;
        r.style.transform = shift ? `translateY(${shift}px)` : "";
      });
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      handle.removeEventListener("lostpointercapture", onEnd);
      if (target !== from) {
        const [moved] = prefs.currencies.splice(from, 1);
        prefs.currencies.splice(target, 0, moved);
        savePrefs();
      }
      renderList();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
    handle.addEventListener("lostpointercapture", onEnd);
  });
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
  if (on && activeInput) stopEditing();
  editBtn.setAttribute("aria-pressed", String(on));
  editBtn.textContent = t(on ? "done" : "edit");
  listEl.classList.toggle("editing", on);
}

// ---------- picker ----------

function renderPicker() {
  const q = pickerSearch.value.trim().toLowerCase();
  pickerList.replaceChildren();
  for (const [code, englishName] of Object.entries(currencies)) {
    const name = I18n.currencyName(code, englishName);
    // Match the code and both the displayed and English names, so English searches still work in Chinese.
    if (q && ![code, name, englishName].some((v) => v.toLowerCase().includes(q))) continue;
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

// ---------- copy amount (long-press) ----------

const LONG_PRESS_MS = 500;
let lastLongPress = 0;
let toastTimer = null;

function showToast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 1800);
}

// Copies synchronously with a temporary textarea + execCommand first: it needs no permission, so there
// is no prompt (the async Clipboard API can show one, and then fails or hangs while it is unanswered),
// and it also works over plain http. The Clipboard API is only the fallback.
async function copyText(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.readOnly = true;
  ta.setAttribute("inputmode", "none");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  if (ok) return true;
  if (!(navigator.clipboard && window.isSecureContext)) return false;
  try {
    // Don't wait forever on an unanswered permission prompt.
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(reject, 2000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

// Plain number for pasting elsewhere: no thousands separators.
function plainAmount(value, code) {
  if (value == null || !isFinite(value)) return "";
  const digits = Math.abs(value) < 1 ? { maximumSignificantDigits: 4 } : { maximumFractionDigits: currencyDigits(code) };
  return new Intl.NumberFormat("en-US", { ...digits, useGrouping: false }).format(value);
}

// Copies the row's amount; resolves to true on success, false on failure, null if there is nothing to copy.
async function copyRowValue(row, toastOnFailure = true) {
  const code = row.dataset.code;
  const value = code === prefs.baseCode ? prefs.baseAmount : convert(prefs.baseAmount, prefs.baseCode, code);
  const text = plainAmount(value, code);
  if (!text) return null;
  const ok = await copyText(text);
  if (ok) showToast(t("copied", { value: `${text} ${code}` }));
  else if (toastOnFailure) showToast(t("copyFailed"));
  return ok;
}

// Browsers only allow copying shortly after a user action. A touch press (pointerdown) does not count as
// one, only lifting the finger does, so a copy fired from the 500 ms timer fails unless the user happened to
// interact within the last few seconds (typically the first copy after a page load). So the timer only
// "arms" the press and tries once; the release then copies if that attempt didn't succeed.
function setupCopy() {
  let timer = null;
  let armedRow = null;   // the row whose press has lasted long enough
  let copied = false;
  let startX = 0;
  let startY = 0;
  const cancelTimer = () => clearTimeout(timer);

  listEl.addEventListener("pointerdown", (e) => {
    const row = e.target.closest(".row");
    if (editing || !row || !e.target.closest(".value") || e.button > 0) return;
    startX = e.clientX;
    startY = e.clientY;
    armedRow = null;
    cancelTimer();
    timer = setTimeout(async () => {
      armedRow = row;
      copied = false;
      lastLongPress = Date.now();
      if (navigator.vibrate) navigator.vibrate(15);
      copied = (await copyRowValue(row, false)) !== false; // a failure is reported only after the release attempt
    }, LONG_PRESS_MS);
  });
  listEl.addEventListener("pointermove", (e) => {
    if (!armedRow && Math.hypot(e.clientX - startX, e.clientY - startY) > 8) cancelTimer(); // scrolling
  });
  const release = async () => {
    cancelTimer();
    const row = armedRow;
    armedRow = null;
    if (!row) return;
    lastLongPress = Date.now();
    if (!copied) await copyRowValue(row);
  };
  for (const type of ["pointerup", "pointercancel"]) listEl.addEventListener(type, release);
  listEl.addEventListener("pointerleave", () => { if (!armedRow) cancelTimer(); });
  window.addEventListener("scroll", () => { if (!armedRow) cancelTimer(); }, { passive: true });
  // Long-press opens the browser's text menu on touch devices; we use it for copying instead.
  listEl.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".value")) e.preventDefault();
  });
}

// ---------- rate chart ----------

const SVG_NS = "http://www.w3.org/2000/svg";
const chartSvg = $("#chart-svg");
const chartMsg = $("#chart-msg");
const chartTitle = $("#chart-title");
const chartChange = $("#chart-change");
const chartReadout = $("#chart-readout");
let chartPair = null;   // { base, quote }
let chartPoints = [];
let chartToken = 0;     // drops responses that arrive after the pair or range changed

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function chartTime(ts, range) {
  const d = new Date(ts * 1000);
  const opts = range === "1d" || range === "1w"
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" };
  return d.toLocaleString(I18n.lang, opts);
}

function chartRange() {
  return prefs.chartRange || "1m";
}

function setChartReadout(point) {
  const { base, quote } = chartPair;
  chartReadout.replaceChildren();
  if (!point) return;
  const strong = document.createElement("b");
  strong.textContent = `1 ${base} = ${formatRate(point[1])} ${quote}`;
  chartReadout.append(strong, document.createElement("br"), chartTime(point[0], chartRange()));
}

function drawChart() {
  chartSvg.replaceChildren();
  chartMsg.textContent = "";
  const pts = chartPoints;
  if (pts.length < 2) return;
  const W = chartSvg.clientWidth || 300;
  const H = chartSvg.clientHeight || 180;
  const padL = 4, padR = 44, padT = 10, padB = 16;
  chartSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const vals = pts.map((p) => p[1]);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi === lo) { hi += Math.abs(hi) * 0.001 || 1; lo -= Math.abs(lo) * 0.001 || 1; }
  const t0 = pts[0][0];
  const t1 = pts[pts.length - 1][0];
  const x = (ts) => padL + ((ts - t0) / (t1 - t0 || 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

  // Min / max guide lines labelled on the right.
  for (const v of [hi, lo]) {
    chartSvg.append(svgEl("line", { class: "grid", x1: padL, x2: W - padR, y1: y(v), y2: y(v) }));
    const label = svgEl("text", { class: "axis", x: W - padR + 4, y: y(v) + 3 });
    label.textContent = formatRate(v);
    chartSvg.append(label);
  }
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  chartSvg.append(svgEl("path", { class: "area", d: `${line}L${x(t1).toFixed(1)},${H - padB}L${x(t0).toFixed(1)},${H - padB}Z` }));
  chartSvg.append(svgEl("path", { class: "line", d: line }));

  const cursor = svgEl("line", { class: "cursor", y1: padT, y2: H - padB, visibility: "hidden" });
  const dot = svgEl("circle", { class: "dot", r: 4, visibility: "hidden" });
  chartSvg.append(cursor, dot);

  const scrub = (e) => {
    const rect = chartSvg.getBoundingClientRect();
    const ts = t0 + ((e.clientX - rect.left - padL) / (W - padL - padR)) * (t1 - t0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p[0] - ts) < Math.abs(best[0] - ts)) best = p;
    cursor.setAttribute("x1", x(best[0]));
    cursor.setAttribute("x2", x(best[0]));
    dot.setAttribute("cx", x(best[0]));
    dot.setAttribute("cy", y(best[1]));
    cursor.removeAttribute("visibility");
    dot.removeAttribute("visibility");
    setChartReadout(best);
  };
  const release = () => {
    cursor.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    setChartReadout(pts[pts.length - 1]);
  };
  chartSvg.onpointerdown = (e) => { chartSvg.setPointerCapture(e.pointerId); scrub(e); };
  chartSvg.onpointermove = scrub; // also follows a hovering mouse
  chartSvg.onpointerup = chartSvg.onpointercancel = chartSvg.onpointerleave = release;
}

function renderChartHeader() {
  const { base, quote } = chartPair;
  chartTitle.textContent = t("chartPair", { base: `${flagFor(base)} ${base}`, quote: `${flagFor(quote)} ${quote}` });
  for (const btn of chartDialog.querySelectorAll("[data-range]")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.range === chartRange()));
  }
}

async function loadChart() {
  const { base, quote } = chartPair;
  const token = ++chartToken;
  chartPoints = [];
  chartSvg.replaceChildren();
  chartChange.textContent = "";
  chartChange.className = "chart-change";
  chartReadout.replaceChildren();
  chartMsg.textContent = t("chartLoading");
  renderChartHeader();
  try {
    const res = await fetch(`api/history?base=${base}&quote=${quote}&range=${chartRange()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (token !== chartToken) return;
    chartPoints = data.points;
  } catch {
    if (token !== chartToken) return;
    chartMsg.textContent = t("chartUnavailable");
    return;
  }
  const first = chartPoints[0][1];
  const last = chartPoints[chartPoints.length - 1][1];
  const pct = ((last - first) / first) * 100;
  const sign = pct > 0 ? "▲ +" : pct < 0 ? "▼ −" : "";
  chartChange.textContent = `${sign}${Math.abs(pct).toFixed(2)}%`;
  chartChange.className = `chart-change ${pct > 0 ? "up" : pct < 0 ? "down" : ""}`;
  drawChart();
  setChartReadout(chartPoints[chartPoints.length - 1]);
}

function openChart(base, quote) {
  if (activeInput) stopEditing();
  chartPair = { base, quote };
  chartDialog.showModal();
  loadChart();
}

function setupChart() {
  for (const btn of chartDialog.querySelectorAll("[data-range]")) {
    btn.addEventListener("click", () => {
      prefs.chartRange = btn.dataset.range;
      savePrefs();
      loadChart();
    });
  }
  chartDialog.addEventListener("close", () => { chartToken++; });
  // A tap on the backdrop (the dialog element itself, outside its content) closes the chart. Both the press and
  // the release must be there, so a scrub that merely ends outside the chart doesn't close it.
  let pressedBackdrop = false;
  chartDialog.addEventListener("pointerdown", (e) => { pressedBackdrop = e.target === chartDialog; });
  chartDialog.addEventListener("click", (e) => {
    if (e.target === chartDialog && pressedBackdrop) chartDialog.close();
    pressedBackdrop = false;
  });
  window.addEventListener("resize", () => { if (chartDialog.open && chartPoints.length) drawChart(); });
}

// ---------- language ----------

// Re-translates everything on screen; called at startup and whenever the language changes.
function applyLanguage() {
  I18n.setChoice(prefs.lang);
  langSelect.value = prefs.lang || "system";
  document.title = t("title");
  I18n.apply(document);
  setEditing(editing);
  if (prefs.currencies) {
    renderList();
    renderStatus();
  }
  if (picker.open) renderPicker();
  if (chartDialog.open && chartPair) {
    renderChartHeader();
    if (chartPoints.length) setChartReadout(chartPoints[chartPoints.length - 1]);
  }
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
  $("#theme-icon").textContent = { system: "◐", light: "☀️", dark: "🌙" }[choice] || "◐";
}

// ---------- data loading ----------

async function loadCurrencies() {
  try {
    const res = await fetch("api/currencies");
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
    const res = await fetch("api/rates", { cache: "no-store" });
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

// Compares the ?v= content hashes in a freshly fetched index.html with the ones this page loaded.
async function newVersionAvailable() {
  const assets = () => [...document.querySelectorAll('script[src*="?v="], link[rel="stylesheet"][href*="?v="]')]
    .map((el) => el.getAttribute("src") || el.getAttribute("href"));
  try {
    const res = await fetch("./", { cache: "no-store" });
    if (!res.ok) return false;
    const html = await res.text();
    return assets().some((url) => !html.includes(`"${url}"`));
  } catch {
    return false; // offline: keep the current version
  }
}

function setupPullToRefresh() {
  let startY = null;
  let pull = 0;

  window.addEventListener("touchstart", (e) => {
    if (window.scrollY > 0 || picker.open || chartDialog.open || e.touches.length !== 1 || ptrEl.classList.contains("refreshing")) return;
    if (e.target.closest("#keypad, .handle")) return; // dragging a row must not pull to refresh
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
    stopEditing();
    // Reload only when a new version of the app is deployed; otherwise just refresh the rates,
    // which updates the page in place without a visible reload.
    const [updated] = await Promise.all([newVersionAvailable(), refreshRates(), new Promise((r) => setTimeout(r, 400))]);
    if (updated) {
      location.reload();
      return;
    }
    ptrEl.classList.remove("refreshing");
    setPull(0, true);
  };
  window.addEventListener("touchend", end);
  window.addEventListener("touchcancel", end);
}

// ---------- init ----------

async function init() {
  applyTheme();
  I18n.setChoice(prefs.lang);

  ratesData = loadJSON(RATES_KEY, null); // show cached rates instantly
  // Use the saved currency list so the first render doesn't wait for the network
  // (waiting left an empty list on screen, which flashed on every reload).
  const cachedMeta = loadJSON(CURRENCIES_KEY, null);
  const meta = cachedMeta || (await loadCurrencies());
  if (cachedMeta) {
    loadCurrencies().then((fresh) => {
      if (fresh && JSON.stringify(fresh) !== JSON.stringify(cachedMeta)) {
        currencies = Object.fromEntries(fresh.currencies.map((c) => [c.code, c.name]));
        renderList();
      }
    });
  }
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
  delete prefs.keypad; // obsolete: the keypad used to be optional
  savePrefs();

  applyLanguage();
  document.documentElement.classList.remove("booting"); // see the inline script in index.html
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
  langSelect.addEventListener("change", () => {
    prefs.lang = langSelect.value;
    savePrefs();
    applyLanguage();
  });
  window.addEventListener("languagechange", () => {
    if (!prefs.lang || prefs.lang === "system") applyLanguage();
  });

  // Re-fetch whenever the app comes back to the foreground or is restored from the back/forward cache.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshRates();
    // Finish editing when the app goes to the background. Otherwise the OS restores focus to the
    // field on return and opens the device keyboard, which ignores inputmode="none" in that case.
    else stopEditing();
  });
  window.addEventListener("pagehide", stopEditing);
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) refreshRates();
  });
  window.addEventListener("online", refreshRates);
  refreshBtn.addEventListener("click", refreshRates);
  setupPullToRefresh();
  setupKeypad();
  setupCopy();
  setupChart();
  window.addEventListener("offline", renderStatus);
  setInterval(renderStatus, 30_000);

  // Pick up preference changes made in another tab.
  window.addEventListener("storage", (e) => {
    if (e.key === PREFS_KEY && e.newValue) {
      prefs = JSON.parse(e.newValue);
      applyTheme();
      applyLanguage();
    }
  });
}

// ---------- PWA ----------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW registration failed", err));
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
