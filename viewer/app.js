// hipokamp: podgląd pamięci. Vanilla JS jako moduł ES, bez kroku budowania i bez frameworków.
// Treść notatek pochodzi z transkryptów, więc do DOM trafia wyłącznie jako tekst
// (textContent, createTextNode, append). Nigdzie nie używamy innerHTML.
// Teksty interfejsu idą wyłącznie przez funkcję t ze słowników w i18n/ (angielski domyślnie, polski opcjonalnie).
// Danych użytkownika (tytuły, treść notatek, nazwy projektów, ścieżki, id) nie tłumaczymy.

import { applyStatic, createI18n, LANGS, resolveLang, STORE_LANG } from "./i18n.js";
import { viewDashboard } from "./dashboard.js";
import { DICTS } from "./i18n/index.js";
import SERVER_ERRORS from "./i18n/server-errors.js";
import { promptRef } from "./prompt-number.js";

// ---------------------------------------------------------------------------
// 1. Język, stałe, formaty
// ---------------------------------------------------------------------------

const NBSP = " ";
const PAGE = 50;
const SPRITE = "assets/icons/hexart-ikony-sprite.svg";
const STORE_PROJECT = "hipokamp:projekt";
const STORE_THEME = "hx-theme";

// Język: domyślnie angielski; polski tylko z polskich ustawień przeglądarki, a przełącznik PL/EN tylko
// wtedy, gdy polski jest wśród języków przeglądarki (reguły w i18n.js). ?lang=pl|en wygrywa na to
// otwarcie (link, zrzut ekranu) i nie jest zapisywany.
function pickLang() {
  let override = "";
  try {
    override = new URLSearchParams(location.search).get("lang") ?? "";
  } catch {
    override = "";
  }
  const languages = navigator.languages?.length ? [...navigator.languages] : [navigator.language].filter(Boolean);
  return resolveLang({ languages, stored: readStore(STORE_LANG), override });
}
const picked = pickLang();
let lang = picked.lang;
const canChooseLang = picked.canChoose;
let I18N = createI18n(lang, DICTS);
/** Cienka nakładka na bieżącego tłumacza: referencje do t zostają ważne po zmianie języka. */
const t = (key, params) => I18N.t(key, params);

/**
 * Etykieta wartości z bazy (typ, status, źródło, kanał...) ze słownika `prefix.wartość`.
 * Nieznana wartość (np. nowy typ notatki) wraca bez zmian albo jako `fallback`.
 */
function label(prefix, value, fallback = value) {
  const key = `${prefix}.${value}`;
  return value != null && I18N.has(key) ? t(key) : fallback;
}

/**
 * Numer promptu jako tura (zakresy w prompt-number.js, te same co w serwerze MCP): numer zastępczy pokazuje numer
 * swojej tury, prompt claude-mem bez tury numer z claude-mem. `heading`: nagłówek grupy w widoku sesji.
 */
function turnLabel(n, heading = false) {
  const r = promptRef(n);
  if (r.kind === "cm") return heading ? t("session.turnNone", { n: r.n }) : t("note.turnNone", { n: r.n });
  if (r.kind === "subst") return heading ? t("session.turnSubst", { n: r.n }) : t("note.turnSubst", { n: r.n });
  return heading ? t("session.turn", { n: r.n }) : t("note.turn", { n: r.n });
}

/** Kolejność grup tur w sesji: według numeru tury, numery zastępcze przy swojej turze, prompty bez tury na końcu. */
function turnOrder(a, b) {
  const x = promptRef(a);
  const y = promptRef(b);
  return (x.kind === "cm") - (y.kind === "cm") || x.n - y.n || a - b;
}

// Typy notatek w kolejności filtra (etykiety: type.*), tony statusów (etykiety: status.*, ws.*).
const TYPES = ["bugfix", "feature", "refactor", "change", "discovery", "decision", "gotcha", "preference"];
const typeLabel = (type) => label("type", type, type || t("common.noType"));
const STATUS_TONE = { active: "success", merged: "info", superseded: "warning", archived: "info" };
// archiwum podglądu: zapomniane i odłożone przez sen (archived) oraz zastąpione nowszą notatką (superseded)
const ARCHIVE_STATUSES = ["archived", "superseded"];
const WS_TONE = {
  todo: "",
  doing: "info",
  in_progress: "info",
  wip: "info",
  done: "success",
  dropped: "",
  blocked: "warning",
  open: "info",
};
// wartość zwracana przez worker (/api/health) przy wyłączonych wektorach, nie tekst interfejsu
const DEVICE_OFF = "wyłączony";

// Formaty liczb, dat i czasu względnego zależą od języka: budujemy je od nowa przy każdej zmianie.
let nf;
let nf2;
let dfDate;
let dfShort;
let dfTime;
let rtf;
function buildFormats() {
  const loc = I18N.locale;
  nf = new Intl.NumberFormat(loc);
  nf2 = new Intl.NumberFormat(loc, { maximumFractionDigits: 2 });
  dfDate = new Intl.DateTimeFormat(loc, { day: "numeric", month: "long", year: "numeric" });
  dfShort = new Intl.DateTimeFormat(loc, { day: "2-digit", month: "2-digit", year: "numeric" });
  dfTime = new Intl.DateTimeFormat(loc, { hour: "2-digit", minute: "2-digit" });
  rtf = new Intl.RelativeTimeFormat(loc, { numeric: "auto" });
}
buildFormats();

const num = (n) => nf.format(Number(n) || 0);
/** Listy z API bywają surowym JSON-em z bazy (np. podsumowanie sesji): zawsze zwraca tablicę tekstów. */
function toArr(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== "").map(String);
  if (typeof v === "string" && v.trim()) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return toArr(p);
    } catch {
      // zwykły tekst: jedna pozycja
    }
    return [v];
  }
  return [];
}
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const pct = (x) => `${Math.round(clamp01(x) * 100)}%`;
const eqi = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

function sameDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}
const fmtDate = (ms) => dfDate.format(ms).replace(/ /g, NBSP);
const fmtDateTime = (ms) => `${fmtDate(ms)}, ${dfTime.format(ms)}`;

function fmtRel(ms) {
  if (!ms) return "";
  const now = Date.now();
  const d = now - ms;
  if (d < 45_000 && d > -60_000) return t("time.justNow");
  if (d > 0 && d < 3_600_000) return rtf.format(-Math.max(1, Math.round(d / 60_000)), "minute");
  if (d > 0 && d < 6 * 3_600_000) return rtf.format(-Math.round(d / 3_600_000), "hour");
  if (sameDay(ms, now)) return t("time.today", { time: dfTime.format(ms) });
  if (sameDay(ms, now - 86_400_000)) return t("time.yesterday", { time: dfTime.format(ms) });
  return `${dfShort.format(ms)}, ${dfTime.format(ms)}`;
}

function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return t("dur.s", { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t("dur.min", { n: m });
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  if (hh < 48) return mm ? t("dur.hm", { h: hh, m: mm }) : t("dur.h", { h: hh });
  return t("dur.days", { n: Math.floor(hh / 24) });
}

// ---------------------------------------------------------------------------
// 2. DOM: elementy budowane z tekstu, nigdy z HTML
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
let uidSeq = 0;
const uid = (p) => `${p}-${++uidSeq}`;

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** Natywne append zamienia null na tekst „null”: tu puste pozycje po prostu pomijamy. */
function appendAll(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function icon(name, cls = "app-icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `${SPRITE}#hx-i-${name}`);
  svg.append(use);
  return svg;
}

/** Wartość 0..1 dla pasków: przez CSSOM (dozwolone przy style-src 'self'), nie atrybutem style. */
function setV(el, v) {
  el.style.setProperty("--app-v", String(clamp01(v)));
  return el;
}

function btn(text, { variant = "", size = "", spinner = false, type = "button", cls = "" } = {}) {
  const c = ["hx-btn", variant && `hx-btn--${variant}`, size && `hx-btn--${size}`, cls].filter(Boolean).join(" ");
  return h("button", { class: c, type }, spinner ? h("span", { class: "hx-btn__spinner", "aria-hidden": "true" }) : null, text);
}
function setBusy(b, on) {
  if (on) b.setAttribute("aria-busy", "true");
  else b.removeAttribute("aria-busy");
}
const isBusy = (b) => b.getAttribute("aria-busy") === "true";

function viewHead(kicker, title, lead, { clamp = false } = {}) {
  return h(
    "header",
    { class: "view-head" },
    h("p", { class: "hx-kicker" }, kicker),
    h("h1", { class: clamp ? "view-title app-clamp" : "view-title", tabindex: "-1", title: clamp ? title : null }, title),
    lead ? h("p", { class: "view-lead" }, lead) : null,
  );
}

function crumbs(items) {
  return h(
    "nav",
    { class: "hx-breadcrumbs app-crumbs", "aria-label": t("common.breadcrumb") },
    h(
      "ol",
      null,
      items.map(([text, href]) => h("li", null, href ? h("a", { href }, text) : h("span", { "aria-current": "page" }, text))),
    ),
  );
}

function emptyState(title, text, action) {
  return h(
    "div",
    { class: "app-empty hx-chamfer hx-chamfer--line" },
    h("p", { class: "app-empty__title" }, title),
    text ? h("p", null, text) : null,
    action ?? null,
  );
}

function errorAlert(err, retry) {
  const b = retry ? btn(t("common.retry"), { variant: "secondary", size: "sm" }) : null;
  b?.addEventListener("click", retry);
  return h(
    "div",
    { class: "hx-alert hx-alert--error app-alert", role: "alert" },
    h("p", { class: "hx-alert__title" }, t("err.load")),
    h("p", { class: "hx-alert__body" }, err?.message || String(err)),
    b,
  );
}

const loadingText = (text) => h("p", { class: "app-loading", role: "status" }, text);

function timeEl(ms, { abs = false } = {}) {
  if (!ms) return null;
  return h(
    "time",
    { datetime: new Date(ms).toISOString(), title: abs ? null : fmtDateTime(ms), "data-ms": abs ? null : ms },
    abs ? fmtDateTime(ms) : fmtRel(ms),
  );
}

function typeBadge(type) {
  return h("span", { class: "hx-badge" }, typeLabel(type));
}

/** Plakietka statusu innego niż oczekiwany na liście (zwykle aktywna; w archiwum: w archiwum). */
/** Statusy listy z data-expect („archived superseded”): pierwszy to status bez plakietki, wszystkie bez przygaszenia. */
const expectList = (expect) => String(expect || "active").split(" ").filter(Boolean);

function statusBadge(status, expect = "active") {
  const s = status || "active";
  if (s === expectList(expect)[0]) return null;
  const tone = STATUS_TONE[s] ?? "info";
  return h(
    "span",
    { class: `hx-badge hx-badge--${tone}`, "data-status-badge": "" },
    h("span", { class: "hx-badge__dot", "aria-hidden": "true" }),
    label("status", s),
  );
}

function toneBadge(text, tone) {
  return h(
    "span",
    { class: tone ? `hx-badge hx-badge--${tone}` : "hx-badge" },
    tone ? h("span", { class: "hx-badge__dot", "aria-hidden": "true" }) : null,
    text,
  );
}

function kv(rows) {
  const dl = h("dl", { class: "app-kv" });
  for (const [k, v] of rows) {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    dl.append(h("dt", null, k), h("dd", null, v));
  }
  return dl;
}

function fileList(files, max = 30) {
  const shown = files.slice(0, max);
  return h(
    "ul",
    { class: "app-files" },
    shown.map((f) => h("li", { class: "app-mono" }, f)),
    files.length > max ? h("li", { class: "hx-help" }, t("common.andMore", { n: files.length - max })) : null,
  );
}

function meter(v) {
  const fill = setV(h("span", { class: "app-meter__fill" }), v);
  return h(
    "span",
    { class: "app-meter" },
    h("span", { class: "app-meter__bar", "aria-hidden": "true" }, fill),
    h("span", null, nf2.format(clamp01(v))),
  );
}

function relevance(conf) {
  const fill = setV(h("span", { class: "app-rel__fill" }), conf);
  return h(
    "span",
    { class: "app-rel" },
    h("span", null, t("search.relevance")),
    h("span", { class: "app-rel__bar", "aria-hidden": "true" }, fill),
    h("span", { class: "app-rel__value" }, pct(conf)),
  );
}

function barChart(items, ariaLabel) {
  const max = Math.max(1, ...items.map((i) => Number(i.value) || 0));
  return h(
    "ul",
    { class: "app-bars", "aria-label": ariaLabel },
    items.map((it) =>
      h(
        "li",
        { class: "app-bar" },
        h("span", { class: "app-bar__label", title: it.title ?? null }, it.label),
        h("span", { class: "app-bar__track", "aria-hidden": "true" }, setV(h("span", { class: "app-bar__fill" }), (Number(it.value) || 0) / max)),
        h("span", { class: "app-bar__value" }, num(it.value)),
      ),
    ),
  );
}

let toastTimer = 0;
/**
 * Komunikat na dole ekranu. action = { label, run, focus }: przycisk (np. Cofnij), komunikat wisi dłużej i nie
 * znika, dopóki kursor albo fokus jest na nim. focus() wskazuje, dokąd wraca fokus z klawiatury po akcji.
 */
function toast(msg, action = null) {
  const el = $("#toast");
  let b = null;
  if (action) {
    b = btn(action.label, { variant: "ghost", size: "sm", cls: "app-toast__action" });
    b.addEventListener("click", async () => {
      const fromKeys = el.contains(document.activeElement);
      hideToast();
      await action.run();
      if (fromKeys) (action.focus?.() ?? $("#main"))?.focus({ preventScroll: true });
    });
  }
  el.replaceChildren();
  appendAll(el, h("span", { class: "app-toast__text" }, msg), b);
  el.dataset.open = "true";
  armToast(action ? 8000 : 2600);
}
function armToast(ms) {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  clearTimeout(toastTimer);
  $("#toast").dataset.open = "false";
}
function initToast() {
  const el = $("#toast");
  const hold = () => clearTimeout(toastTimer);
  // w trakcie focusout activeElement to jeszcze body, więc sprawdzenie fokusu przechodzi
  const release = () => {
    if (el.dataset.open === "true" && !el.matches(":hover") && !el.contains(document.activeElement)) armToast(3000);
  };
  el.addEventListener("pointerenter", hold);
  el.addEventListener("focusin", hold);
  el.addEventListener("pointerleave", release);
  el.addEventListener("focusout", (e) => {
    if (!el.contains(e.relatedTarget)) release();
  });
}

function announce(msg) {
  const a = $("#announcer");
  a.textContent = "";
  requestAnimationFrame(() => {
    a.textContent = msg;
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { class: "hx-sr-only", readonly: true, "aria-hidden": "true" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function copyIdButton(id) {
  const b = h(
    "button",
    { class: "hx-btn hx-btn--sm hx-btn--ghost", type: "button", "aria-label": t("common.copyLabel", { id }) },
    t("common.copy"),
    " ",
    h("span", { class: "app-copy" }, `#${id}`),
  );
  b.addEventListener("click", async () => {
    const ok = await copyText(`#${id}`);
    toast(ok ? t("common.copied", { id }) : t("common.copyFailed"));
  });
  return b;
}

// ---------------------------------------------------------------------------
// 3. API workera (same-origin)
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
const isAbort = (e) => e?.name === "AbortError";

async function api(path, { signal, method = "GET", body, bg = false } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      cache: "no-store",
      // worker przyjmuje POST tylko jako JSON (obrona przed prostymi formularzami z obcych stron)
      // bg: odświeżanie w tle (Dashboard), worker nie liczy go jako aktywności człowieka
      headers: method !== "GET" || bg ? { ...(method !== "GET" ? { "content-type": "application/json" } : {}), ...(bg ? { "x-hipokamp-bg": "1" } : {}) } : undefined,
      body: method !== "GET" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ApiError(t("err.workerDown"), 0);
  }
  // 401: brak albo wygasłe ciasteczko podglądu (np. nowy klucz workera). Ekran wejścia zamiast widoku, a wywołujący
  // dostaje przerwanie (jak przy zmianie widoku): żadnego komunikatu „HTTP 401” pod ekranem wejścia
  if (res.status === 401) {
    showGate(hadSession ? "lost" : "missing");
    throw new DOMException("gate", "AbortError");
  }
  hadSession = true;
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = data && typeof data.error === "string" ? serverMessage(data.error) : res.statusText;
    throw new ApiError(t("err.http", { status: res.status, msg }), res.status);
  }
  return data;
}

// ---------------------------------------------------------------------------
// 3a. Wejście do podglądu (T-34): API workera wymaga ciasteczka z `hipokamp open`
// ---------------------------------------------------------------------------

/** Polecenie, które otwiera podgląd z jednorazowym biletem (nazwa komendy CLI, nie tekst do tłumaczenia). */
const OPEN_CMD = "hipokamp open";
/** Powód ekranu wejścia: null (podgląd działa), "missing", "invalid" (zły albo zużyty bilet), "lost" (wygasło). */
let gateReason = null;
/** Czy worker choć raz przyjął żądanie tej karty: dopiero wtedy 401 znaczy „dostęp wygasł”, a nie „brak dostępu”. */
let hadSession = false;

/** Parametr ?auth= z przekierowania workera po złym bilecie: odczyt i usunięcie z adresu (hash zostaje). */
function takeAuthParam() {
  try {
    const url = new URL(location.href);
    const v = url.searchParams.get("auth");
    if (v == null) return null;
    url.searchParams.delete("auth");
    history.replaceState(history.state, "", url);
    return v;
  } catch {
    return null;
  }
}

/**
 * Stan dostępu: "ok" (ciasteczko ważne), "none" (401) albo "down" (worker nie odpowiada; widoki pokażą błąd,
 * a ekran wejścia pojawi się przy pierwszym 401 po jego powrocie).
 */
async function sessionState() {
  try {
    const res = await fetch("/api/viewer", { cache: "no-store" });
    if (res.status === 401) return "none";
    if (res.ok) hadSession = true;
    return "ok";
  } catch {
    return "down";
  }
}

/** Ekran wejścia zamiast widoku: strumień zamknięty, panel zamknięty, nawigacja ukryta (CSS: body[data-gate]). */
function showGate(reason) {
  if (gateReason) return;
  gateReason = reason;
  route.ctrl?.abort();
  try {
    route.cleanup?.();
  } catch {
    // sprzątanie widoku nie może zatrzymać ekranu wejścia
  }
  route.key = null;
  clearTimeout(live.timer);
  clearTimeout(live.recycleTimer);
  live.es?.close();
  live.es = null;
  if (panel.id != null) closePanel();
  document.body.dataset.gate = "true";
  applyLive("off");
  renderGate();
}

function renderGate() {
  const copy = btn(t("gate.copy"), { variant: "secondary", size: "sm" });
  copy.addEventListener("click", async () => toast((await copyText(OPEN_CMD)) ? t("gate.copied") : t("common.copyFailed")));
  const again = btn(t("gate.retry"), { variant: "ghost", size: "sm" });
  again.addEventListener("click", () => location.reload());
  const root = $("#view");
  root.replaceChildren(
    h(
      "section",
      { class: "app-gate" },
      viewHead(t("gate.kicker"), t("gate.title"), t("gate.lead")),
      gateReason === "missing"
        ? null
        : h(
            "div",
            { class: "hx-alert hx-alert--warning app-alert", role: "alert" },
            h("p", { class: "hx-alert__body" }, t(gateReason === "invalid" ? "gate.invalid" : "gate.lost")),
          ),
      h(
        "div",
        { class: "hx-card app-gate__card" },
        h("p", { class: "hx-card__kicker" }, t("gate.stepsTitle")),
        h("ol", { class: "app-gate__steps" }, h("li", null, t("gate.step1")), h("li", null, t("gate.step2"))),
        h("pre", { class: "app-gate__cmd" }, h("code", null, OPEN_CMD)),
        h("div", { class: "app-gate__actions" }, copy, again),
        h("p", { class: "hx-card__body" }, t("gate.why")),
      ),
    ),
  );
  $(".view-title", root)?.focus({ preventScroll: true });
}

/** Worker odpowiada po polsku: w polskim interfejsie zostaje oryginał, w angielskim znany komunikat jest tłumaczony. */
function serverMessage(msg) {
  const key = lang === "pl" || !Object.hasOwn(SERVER_ERRORS, msg) ? null : SERVER_ERRORS[msg];
  return key && I18N.has(key) ? t(key) : msg;
}

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v != null && v !== "") p.set(k, String(v));
  return p.toString();
}

const anySignal = (...signals) => (AbortSignal.any ? AbortSignal.any(signals) : signals[signals.length - 1]);

// ---------------------------------------------------------------------------
// 4. Stan globalny: projekt, lista projektów
// ---------------------------------------------------------------------------

const state = {
  project: "",
  projects: [],
};

function readStore(key) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function writeStore(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // tryb prywatny: wybór działa do zamknięcia karty
  }
}

function setProject(p) {
  state.project = p || "";
  writeStore(STORE_PROJECT, state.project);
  refreshProjectSelects();
}

async function loadProjects(signal) {
  try {
    const rows = await api("/api/projects", { signal });
    state.projects = Array.isArray(rows) ? rows : [];
    refreshProjectSelects();
  } catch {
    // brak listy projektów nie blokuje widoków: zostaje „Wszystkie projekty”
  }
  return state.projects;
}

function fillProjectOptions(sel) {
  const required = sel.dataset.required === "true";
  const list = [...state.projects];
  if (state.project && !list.some((p) => eqi(p.project, state.project))) list.unshift({ project: state.project, observations: null });
  const opts = [h("option", { value: "" }, required ? t("common.chooseProject") : t("common.allProjects"))];
  for (const p of list) {
    opts.push(h("option", { value: p.project }, p.observations == null ? p.project : `${p.project} (${num(p.observations)})`));
  }
  sel.replaceChildren(...opts);
  sel.value = list.find((p) => eqi(p.project, state.project))?.project ?? "";
}

function refreshProjectSelects() {
  for (const sel of document.querySelectorAll("select[data-project-select]")) fillProjectOptions(sel);
}

function projectField(onChange, { required = false } = {}) {
  const id = uid("projekt");
  const sel = h("select", { class: "hx-select", id, "data-project-select": "", "data-required": String(required) });
  fillProjectOptions(sel);
  sel.addEventListener("change", () => {
    setProject(sel.value);
    onChange?.();
  });
  return h("div", { class: "hx-field app-field" }, h("label", { class: "hx-label", for: id }, t("common.project")), sel);
}

function parseTypes(v) {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Filtr typów: przełączniki z aria-pressed, „Wszystkie” czyści wybór. */
function typeFilter(initial, onChange) {
  let cur = [...initial];
  const id = uid("typ");
  const chip = (text) => h("button", { class: "hx-tag hx-fill app-chip", type: "button", "aria-pressed": "false" }, text);
  const all = chip(t("common.all"));
  const known = new Set(TYPES);
  const entries = [...TYPES, ...cur.filter((k) => !known.has(k))];
  const btns = entries.map((key) => [key, chip(typeLabel(key))]);
  const sync = () => {
    all.setAttribute("aria-pressed", String(cur.length === 0));
    for (const [key, b] of btns) b.setAttribute("aria-pressed", String(cur.includes(key)));
  };
  all.addEventListener("click", () => {
    if (!cur.length) return;
    cur = [];
    sync();
    onChange([]);
  });
  for (const [key, b] of btns) {
    b.addEventListener("click", () => {
      cur = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
      sync();
      onChange([...cur]);
    });
  }
  sync();
  return h(
    "div",
    { class: "app-fieldset", role: "group", "aria-labelledby": id },
    h("span", { class: "hx-label", id }, t("common.noteType")),
    h(
      "div",
      { class: "app-chips" },
      all,
      btns.map(([, b]) => b),
    ),
  );
}

// ---------------------------------------------------------------------------
// 5. Router (hash): #/widok[/argument][?parametry], &n=ID otwiera panel notatki
// ---------------------------------------------------------------------------

const VIEWS = {
  dashboard: (root, r, signal) => viewDashboard(root, r, signal, dashboardKit()),
  strumien: viewStream,
  szukaj: viewSearch,
  sesje: viewSessions,
  sesja: viewSession,
  projekty: viewProjects,
  praca: viewWork,
  statystyki: viewStats,
  "os-czasu": viewTimeline,
};
// tytuły kart (document.title) liczone przy każdym renderze, więc zmieniają się razem z językiem
const TITLES = {
  dashboard: () => t("nav.dashboard"),
  strumien: () => t("nav.stream"),
  szukaj: () => t("nav.search"),
  sesje: () => t("nav.sessions"),
  sesja: () => t("nav.session"),
  projekty: () => t("nav.projects"),
  praca: () => t("nav.work"),
  statystyki: () => t("nav.stats"),
  "os-czasu": () => t("nav.timeline"),
};
const NAV_OF = { sesja: "sesje", "os-czasu": "strumien" };
const NEEDS_ARG = new Set(["sesja", "os-czasu"]);

const route = {
  view: null,
  arg: null,
  params: new URLSearchParams(),
  key: null,
  ctrl: null,
  live: null,
  // hook widoku na zmianę statusu notatki (SSE albo własna akcja), przed aktualizacją wierszy na miejscu
  status: null,
  // (id, status) => true, gdy widok chce notatkę spoza ekranu, która właśnie zmieniła status (strumień)
  wants: null,
  refresh: null,
  cleanup: null,
};
let firstRender = true;
let pendingFocus = null;
let lastSearch = "";
// true tylko podczas cichego przerysowania (zmiana języka, resync strumienia): fokus zostaje, strona się nie przewija
let quietRender = false;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const qi = raw.indexOf("?");
  const path = qi >= 0 ? raw.slice(0, qi) : raw;
  const params = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "");
  const parts = path.split("/").filter(Boolean);
  const view = parts[0] ?? "";
  let arg = parts.length > 1 ? parts.slice(1).join("/") : null;
  try {
    arg = arg == null ? null : decodeURIComponent(arg);
  } catch {
    arg = null;
  }
  const valid = Object.hasOwn(VIEWS, view) && (!NEEDS_ARG.has(view) || !!arg);
  return { view: valid ? view : "dashboard", arg: valid ? arg : null, params, valid };
}

function hashFor(view, arg = null, params = null) {
  let s = `#/${view}`;
  if (arg != null && arg !== "") s += `/${encodeURIComponent(arg)}`;
  const p = params instanceof URLSearchParams ? params : new URLSearchParams(qs(params ?? {}));
  const q = p.toString();
  return q ? `${s}?${q}` : s;
}

function routeKey(r) {
  const p = new URLSearchParams(r.params);
  p.delete("n");
  p.sort();
  return `${r.view}/${r.arg ?? ""}?${p}`;
}

/** Zmienia parametry bieżącego widoku bez przerysowania (replaceState nie wywołuje hashchange). */
function setParams(patch) {
  const r = parseHash();
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "") r.params.delete(k);
    else r.params.set(k, String(v));
  }
  const target = hashFor(r.view, r.arg, r.params);
  if (target !== location.hash) history.replaceState(history.state, "", target);
  route.params = r.params;
  route.key = routeKey(r);
}

function noteHref(id) {
  const p = new URLSearchParams(route.params);
  p.set("n", String(id));
  return hashFor(route.view ?? "dashboard", route.arg, p);
}

function onRoute() {
  if (gateReason) return renderGate();
  let r = parseHash();
  if (!r.valid) {
    history.replaceState(null, "", hashFor("dashboard"));
    r = parseHash();
  }
  const key = routeKey(r);
  if (key !== route.key) renderView(r, key);
  const n = Number(r.params.get("n"));
  syncPanel(Number.isInteger(n) && n > 0 ? n : null);
}

function renderView(r, key) {
  route.ctrl?.abort();
  try {
    route.cleanup?.();
  } catch {
    // sprzątanie poprzedniego widoku nie może zatrzymać nawigacji
  }
  Object.assign(route, {
    view: r.view,
    arg: r.arg,
    params: r.params,
    key,
    ctrl: new AbortController(),
    live: null,
    status: null,
    wants: null,
    refresh: null,
    cleanup: null,
  });

  const navKey = NAV_OF[r.view] ?? r.view;
  for (const a of document.querySelectorAll("[data-nav]")) {
    if (a.dataset.nav === navKey) {
      a.setAttribute("aria-current", "page");
      const list = a.closest(".app-nav__list");
      if (list && list.scrollWidth > list.clientWidth) list.scrollLeft = Math.max(0, a.offsetLeft - 16);
    } else a.removeAttribute("aria-current");
  }
  if (r.view === "strumien") setUnseen(0);
  const title = TITLES[r.view];
  document.title = `${typeof title === "function" ? title() : title} · hipokamp`;

  const root = $("#view");
  root.replaceChildren();
  VIEWS[r.view](root, r, route.ctrl.signal);

  if (!firstRender && !quietRender) {
    window.scrollTo(0, 0);
    const target = (pendingFocus && $(pendingFocus)) || $(".view-title", root);
    target?.focus({ preventScroll: true });
    if (pendingFocus === "#q") target?.select?.();
  }
  pendingFocus = null;
  firstRender = false;
}

// ---------------------------------------------------------------------------
// 5a. Zestaw pomocników dla widoku Dashboard (osobny moduł, bez cyklu importów)
// ---------------------------------------------------------------------------

function dashboardKit() {
  return {
    h,
    btn,
    setBusy,
    isBusy,
    viewHead,
    emptyState,
    errorAlert,
    loadingText,
    timeEl,
    toneBadge,
    kv,
    toast,
    announce,
    api,
    qs,
    hashFor,
    setProject,
    noteRow,
    sessionRow,
    setV,
    copyText,
    readStore,
    writeStore,
    isAbort,
    uid,
    num,
    fmtRel,
    fmtDur,
    t,
    locale: () => I18N.locale,
    route,
    state,
  };
}

// ---------------------------------------------------------------------------
// 6. Wiersz notatki i panel szczegółów
// ---------------------------------------------------------------------------

/**
 * Wiersz notatki. manage: przycisk Zapomnij albo Przywróć w wierszu. expect: statusy, które ta lista pokazuje, po
 * spacji (archiwum: „archived superseded”); status inny niż pierwszy dostaje plakietkę, a status spoza listy po
 * zmianie na żywo przygasza wiersz (syncRow).
 */
function noteRow(o, { level = 2, tag = "li", extra = null, isNew = false, scores = null, manage = false, expect = "active" } = {}) {
  const row = h(tag, {
    class: `note hx-chamfer hx-chamfer--line${isNew ? " note--new" : ""}`,
    "data-id": o.id,
    "data-status": o.status || "active",
    "data-expect": expect,
  });
  const link = h("a", { class: "note__link", href: noteHref(o.id), "data-note": o.id }, o.title || t("note.untitled"));
  const nfiles = toArr(o.files_modified).length;
  const sub = [o.subtitle, o.narrative].find((x) => typeof x === "string" && x.trim() && x !== o.title) ?? null;
  appendAll(
    row,
    h(
      "div",
      { class: "note__top" },
      typeBadge(o.type),
      statusBadge(o.status, expect),
      isNew ? h("span", { class: "hx-badge hx-badge--gold app-new" }, t("note.new")) : null,
      extra,
      manage ? h("span", { class: "note__actions", "data-note-actions": "" }, noteAction(o)) : null,
    ),
    h(`h${level}`, { class: "note__title" }, link),
    sub ? h("p", { class: "note__sub" }, sub) : null,
    h(
      "p",
      { class: "note__meta" },
      h("span", { class: "note__project" }, o.project),
      timeEl(o.created_at),
      o.prompt_n ? h("span", null, turnLabel(o.prompt_n)) : null,
      nfiles ? h("span", null, t("note.filesChanged", { n: nfiles })) : null,
      scores,
      h("span", { class: "app-mono" }, `#${o.id}`),
    ),
  );
  if (panel.id === o.id) {
    row.setAttribute("data-selected", "");
    link.setAttribute("aria-current", "true");
  }
  return row;
}

// ---------------------------------------------------------------------------
// 6a. Zapomnij i przywróć: przycisk w wierszu i w panelu, okno potwierdzenia, Cofnij w komunikacie
// ---------------------------------------------------------------------------

// notatki zmieniane z tej karty: id -> oczekiwany status. Echo z SSE dla nich nie trafia do ogłoszeń
// (komunikat z Cofnij już to powiedział)
const ownChanges = new Map();

/**
 * Przycisk akcji dla notatki: aktywna = Zapomnij (z potwierdzeniem), w archiwum albo zastąpiona = Przywróć;
 * scalona bez akcji (jej treść żyje w notatce docelowej).
 */
function noteAction(o, { variant = "ghost" } = {}) {
  const status = o.status || "active";
  if (status !== "active" && status !== "archived" && status !== "superseded") return null;
  const forget = status === "active";
  const b = btn(forget ? t("forget.button") : t("restore.button"), { variant, size: "sm", spinner: true, cls: "app-note-action" });
  b.setAttribute("aria-label", forget ? t("forget.buttonLabel", { id: o.id }) : t("restore.buttonLabel", { id: o.id }));
  b.addEventListener("click", () => {
    if (isBusy(b) || document.querySelector("dialog[open]")) return;
    if (forget) void askForget(o, b);
    else void setNotesStatus([o.id], "restore", { trigger: b });
  });
  return b;
}

/**
 * Gdzie postawić fokus po zmianie statusu notatki: tytuł panelu albo link wiersza, nigdy nowy przycisk akcji.
 * Przywróć działa bez potwierdzenia, więc szybki kolejny Enter po potwierdzeniu zapomnienia (albo po Cofnij)
 * od razu by je odwrócił. Cofnięcie jest w komunikacie.
 */
function focusAfterChange(id) {
  if (panel.id === id) {
    const title = $("#panel-title");
    if (title) return title;
  }
  return $(`#view .note[data-id="${id}"] .note__link`);
}

async function askForget(o, trigger) {
  const answer = await forgetDialog(o);
  // fokus wraca do przycisku, który otworzył okno (przeglądarka robi to sama tylko wtedy, gdy przycisk miał fokus);
  // po zapomnieniu syncRow i refreshPanel przenoszą go na link wiersza albo tytuł panelu
  if (trigger.isConnected) trigger.focus({ preventScroll: true });
  if (answer) await setNotesStatus([o.id], "forget", { reason: answer.reason, trigger });
}

/**
 * Okno potwierdzenia zapomnienia (natywny <dialog>: pułapka fokusu, Esc, tło inert). Wynik: { reason } albo null.
 * Klik w tło zamyka okno jak Esc; Enter w polu powodu potwierdza.
 */
function forgetDialog(o) {
  return new Promise((resolve) => {
    const titleId = uid("dlg-title");
    const descId = uid("dlg-desc");
    const reasonId = uid("dlg-reason");
    const helpId = uid("dlg-help");
    const reason = h("input", {
      class: "hx-input",
      id: reasonId,
      type: "text",
      maxlength: "300",
      autocomplete: "off",
      autofocus: true,
      "aria-describedby": helpId,
    });
    const cancel = btn(t("forget.cancel"), { variant: "ghost" });
    const form = h(
      "form",
      { class: "app-dialog__form", novalidate: true },
      h("h2", { class: "app-dialog__title", id: titleId }, t("forget.title", { id: o.id })),
      h("p", { class: "app-dialog__subject" }, o.title || t("note.untitled")),
      h("p", { class: "app-dialog__text", id: descId }, t("forget.body")),
      h(
        "div",
        { class: "hx-field" },
        h("label", { class: "hx-label", for: reasonId }, t("forget.reason")),
        reason,
        h("p", { class: "hx-help", id: helpId }, t("forget.reasonHelp")),
      ),
      h("div", { class: "app-dialog__actions" }, cancel, btn(t("forget.confirm"), { type: "submit" })),
    );
    const dlg = h(
      "dialog",
      { class: "app-dialog hx-chamfer hx-chamfer--line", "aria-labelledby": titleId, "aria-describedby": descId },
      form,
    );
    // wynik od razu przy decyzji, nie dopiero w zdarzeniu close (przeglądarka kolejkuje je i bywa, że z opóźnieniem):
    // przycisk, który otworzył okno, jest od tej chwili zajęty i drugi Enter nie otworzy drugiego okna
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(result);
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      finish({ reason: reason.value.trim() });
    });
    cancel.addEventListener("click", () => finish(null));
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) finish(null);
    });
    // Esc: przeglądarka sama zamyka okno; close to zapas na każdy inny sposób zamknięcia
    dlg.addEventListener("cancel", () => finish(null));
    dlg.addEventListener("close", () => finish(null));
    document.body.append(dlg);
    dlg.showModal();
    // fokus od razu, nie przez autofocus (ten czeka na najbliższe rysowanie): szybki drugi Enter trafia już w okno
    reason.focus();
  });
}

/** POST /api/forget albo /api/restore, widok od razu z odpowiedzi; komunikat z Cofnij (undo: false w samym cofnięciu). */
async function setNotesStatus(ids, action, { reason = "", trigger = null, undo = true } = {}) {
  const target = action === "forget" ? "archived" : "active";
  for (const id of ids) ownChanges.set(id, target);
  if (trigger) setBusy(trigger, true);
  try {
    const r = await api(`/api/${action}`, { method: "POST", body: reason ? { ids, reason } : { ids } });
    const changed = Array.isArray(r?.changed) ? r.changed : [];
    for (const id of ids) if (!changed.includes(id)) ownChanges.delete(id);
    for (const o of r?.observations ?? []) if (o && typeof o.id === "number") applyStatus(o);
    if (!changed.length) {
      toast(t("forget.nothing"));
      return;
    }
    const id = changed.join(", #");
    const msg = action === "forget" ? t("forget.done", { id }) : t("restore.done", { id });
    const back = action === "forget" ? "restore" : "forget";
    toast(
      msg,
      undo
        ? { label: t("toast.undo"), run: () => setNotesStatus(changed, back, { undo: false }), focus: () => focusAfterChange(changed[0]) }
        : null,
    );
  } catch (e) {
    for (const id of ids) ownChanges.delete(id);
    // 401: ekran wejścia już jest (api przerywa), bez komunikatu pod nim
    if (isAbort(e)) return;
    toast(e?.message || String(e));
  } finally {
    if (trigger?.isConnected) setBusy(trigger, false);
  }
}

// ostatni pokazany stan notatki: id -> updated_at. Spóźnione echo starszej zmiany (np. zapomnienie, gdy już przyszło
// przywrócenie) nie nadpisuje nowszego stanu
const statusSeen = new Map();
const isStale = (o) => (Number(o.updated_at) || 0) < (statusSeen.get(o.id) ?? 0);

/** Nowy stan notatki (SSE albo własna akcja): bieżący widok, wiersze notatki i otwarty panel. */
function applyStatus(o) {
  if (isStale(o)) return;
  statusSeen.set(o.id, Number(o.updated_at) || 0);
  route.status?.(o);
  for (const row of document.querySelectorAll(`#view .note[data-id="${o.id}"]`)) syncRow(row, o);
  if (panel.id === o.id) refreshPanel(o);
}

/**
 * Wiersz po zmianie statusu: plakietka, przygaszenie (status inny niż lista) i przycisk akcji na miejscu. Fokus
 * z dawnego przycisku idzie na link wiersza (focusAfterChange), nie na nowy przycisk.
 */
function syncRow(row, o) {
  const status = o.status || "active";
  if (row.dataset.status === status) return;
  row.dataset.status = status;
  const expect = row.dataset.expect || "active";
  row.toggleAttribute("data-off", !expectList(expect).includes(status));
  const top = $(".note__top", row);
  if (top) {
    top.querySelector("[data-status-badge]")?.remove();
    const badge = statusBadge(status, expect);
    if (badge) top.firstElementChild ? top.firstElementChild.after(badge) : top.prepend(badge);
  }
  const slot = $("[data-note-actions]", row);
  if (slot) {
    const hadFocus = slot.contains(document.activeElement);
    slot.replaceChildren();
    appendAll(slot, noteAction(o));
    if (hadFocus) $(".note__link", row)?.focus({ preventScroll: true });
  }
}

const panel = { id: null, ctrl: null, returnFocus: null, view: "", obs: null };
const viewId = () => `${route.view}/${route.arg ?? ""}`;

function markSelected() {
  for (const el of document.querySelectorAll(".note[data-selected]")) el.removeAttribute("data-selected");
  for (const a of document.querySelectorAll("a[data-note][aria-current]")) a.removeAttribute("aria-current");
  if (panel.id == null) return;
  for (const a of document.querySelectorAll(`a[data-note="${panel.id}"]`)) {
    a.setAttribute("aria-current", "true");
    a.closest(".note")?.setAttribute("data-selected", "");
  }
}

/** Adres bieżącego widoku bez parametru n (panel zamknięty). */
function baseHash() {
  const r = parseHash();
  r.params.delete("n");
  return hashFor(r.view, r.arg, r.params);
}

function openNote(id) {
  const r = parseHash();
  r.params.set("n", String(id));
  const target = hashFor(r.view, r.arg, r.params);
  // pierwsze otwarcie dodaje wpis historii (Wstecz zamyka panel), kolejne go podmieniają
  if (panel.id == null) history.pushState({ panel: true, base: baseHash() }, "", target);
  else history.replaceState(history.state, "", target);
  syncPanel(id);
}

function closePanel() {
  if (panel.id == null) return;
  // Wstecz tylko wtedy, gdy poprzedni wpis to ten sam widok z tymi samymi filtrami
  if (history.state?.panel && history.state.base === baseHash()) {
    history.back();
    return;
  }
  history.replaceState(null, "", baseHash());
  syncPanel(null);
}

const MOBILE = window.matchMedia("(max-width: 767.98px)");

/** Na telefonie panel zakrywa ekran: tło dostaje inert, strona się nie przewija. */
function applyPanelMode() {
  const cover = panel.id != null && MOBILE.matches;
  document.documentElement.classList.toggle("app-lock", cover);
  // na szerokim ekranie (CSS od 1200 px) treść robi miejsce panelowi zamiast chować się pod nim
  document.documentElement.classList.toggle("app-split", panel.id != null && !cover);
  for (const el of document.querySelectorAll("body > header, body > nav, body > main, body > footer, .hx-skip")) {
    el.inert = cover;
  }
}

function syncPanel(id) {
  if (id === panel.id) return;
  const el = $("#panel");
  if (id == null) {
    const closed = panel.id;
    panel.ctrl?.abort();
    panel.id = null;
    panel.obs = null;
    el.dataset.open = "false";
    applyPanelMode();
    markSelected();
    let back = panel.returnFocus;
    panel.returnFocus = null;
    // po przejściu do innego widoku fokus zostaje na jego nagłówku, nie wraca do starej listy
    if (panel.view !== viewId()) return;
    if (!back?.isConnected) back = document.querySelector(`#view a[data-note="${closed}"]`);
    back?.focus({ preventScroll: true });
    return;
  }
  if (panel.id == null) {
    panel.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.view = viewId();
  }
  panel.id = id;
  el.dataset.open = "true";
  applyPanelMode();
  markSelected();
  void loadPanel(id);
}

async function loadPanel(id, { quiet = false } = {}) {
  panel.ctrl?.abort();
  const ctrl = new AbortController();
  panel.ctrl = ctrl;
  panel.obs = null;
  const body = $("#panel-body");
  $("#panel-kicker").textContent = t("note.kicker");
  const title = h("h2", { class: "app-panel__title", id: "panel-title", tabindex: "-1" }, `#${id}`);
  body.replaceChildren(title, loadingText(t("note.loading")));
  try {
    const o = await api(`/api/observation/${id}`, { signal: ctrl.signal });
    if (panel.id !== id) return;
    // zmiana statusu z SSE mogła przyjść w trakcie pobierania: nowszego stanu nie nadpisujemy starszym
    if (!(panel.obs?.id === id && (panel.obs.updated_at ?? 0) >= (o.updated_at ?? 0))) renderNoteDetail(o);
  } catch (e) {
    if (isAbort(e) || panel.id !== id) return;
    body.replaceChildren(title, errorAlert(e, () => loadPanel(id)));
  }
  body.scrollTop = 0;
  // przeładowanie po zmianie języka nie zabiera fokusu przełącznikowi
  if (!quiet) $("#panel-title")?.focus({ preventScroll: true });
}

function noteLink(id) {
  return h("a", { class: "hx-link", href: noteHref(id), "data-note": id }, `#${id}`);
}

/** Wartość z meta notatki do tabeli szczegółów: czasy i znane rodzaje po ludzku, reszta jak jest. */
function metaValue(k, v) {
  if (k === "durationMs") return fmtDur(Number(v));
  if ((k === "restored_at" || k === "forgotten_at") && Number(v) > 0) return fmtDateTime(Number(v));
  if (k === "kind") return v === "human" ? t("meta.kindHuman") : v === "task" ? t("meta.kindTask") : String(v);
  return String(v);
}

/** Panel po zmianie statusu: przerysowanie bez skoku przewinięcia; fokus z przycisku akcji idzie na tytuł panelu. */
function refreshPanel(o) {
  const cur = panel.obs;
  if (cur && cur.id === o.id && cur.status === o.status && cur.updated_at === o.updated_at) return;
  const body = $("#panel-body");
  const active = document.activeElement;
  const fromAction = !!(active && body.contains(active) && active.closest("[data-note-actions]"));
  const top = body.scrollTop;
  renderNoteDetail(o);
  body.scrollTop = top;
  if (fromAction) $("#panel-title")?.focus({ preventScroll: true });
}

function renderNoteDetail(o) {
  panel.obs = o;
  $("#panel-kicker").textContent = `${label("type", o.type, o.type ?? t("note.kicker"))} · #${o.id}`;
  const facts = toArr(o.facts);
  const concepts = toArr(o.concepts);
  const mod = toArr(o.files_modified);
  const read = toArr(o.files_read);

  const head = h(
    "header",
    { class: "app-detail__head" },
    h(
      "div",
      { class: "note__top" },
      typeBadge(o.type),
      statusBadge(o.status),
      o.tier && o.tier !== "episodic" ? h("span", { class: o.tier === "pinned" ? "hx-badge hx-badge--gold" : "hx-badge" }, label("tier", o.tier)) : null,
    ),
    h("h2", { class: "app-panel__title", id: "panel-title", tabindex: "-1" }, o.title || t("note.untitled")),
    o.subtitle && o.subtitle !== o.title ? h("p", { class: "app-panel__lead" }, o.subtitle) : null,
    h(
      "div",
      { class: "hx-cluster" },
      copyIdButton(o.id),
      h("a", { class: "hx-btn hx-btn--sm hx-btn--secondary", href: hashFor("os-czasu", String(o.id)) }, t("note.timeline")),
      o.session_id ? h("a", { class: "hx-btn hx-btn--sm hx-btn--ghost", href: hashFor("sesja", o.session_id) }, t("note.session")) : null,
      h("span", { class: "app-detail__action", "data-note-actions": "" }, noteAction(o)),
    ),
    o.status === "archived" || o.status === "superseded"
      ? h("p", { class: "hx-note app-detail__note" }, t(o.status === "archived" ? "note.archivedHint" : "note.supersededHint"))
      : null,
  );

  const section = (title, ...content) =>
    h("section", { class: "app-section" }, h("h3", { class: "app-section__title" }, title), ...content);

  const statusParts = [label("status", o.status, o.status ?? t("status.active"))];
  const statusDd = h("span", null, statusParts);
  if (o.merged_into) statusDd.append(", ", t("note.mergedFrom"), " ", noteLink(o.merged_into));
  if (o.superseded_by) statusDd.append(", ", t("note.supersededBy"), " ", noteLink(o.superseded_by));

  const metaRows = [];
  if (o.meta && typeof o.meta === "object") {
    for (const [k, v] of Object.entries(o.meta)) {
      if (v == null || v === "" || typeof v === "object") continue;
      // ochrona przed snem po dawnym przywróceniu zostaje w meta także po ponownym zapomnieniu, ale w archiwum
      // „przywrócona z archiwum” myliłoby
      if (k === "restored_at" && (o.status || "active") !== "active") continue;
      metaRows.push([label("meta", k), metaValue(k, v)]);
    }
  }

  const details = kv([
    [t("note.row.type"), `${typeLabel(o.type)} (${o.type ?? "?"})`],
    [t("common.project"), o.project],
    [t("note.session"), o.session_id ? h("a", { class: "hx-link app-mono", href: hashFor("sesja", o.session_id) }, o.session_id) : null],
    [
      t("note.row.turn"),
      o.prompt_n == null ? null : promptRef(o.prompt_n).kind === "turn" ? String(o.prompt_n) : turnLabel(o.prompt_n),
    ],
    [t("note.row.created"), timeEl(o.created_at, { abs: true })],
    [t("note.row.updated"), o.updated_at && o.updated_at !== o.created_at ? timeEl(o.updated_at, { abs: true }) : null],
    [t("note.row.source"), `${label("source", o.source, o.source ?? "?")} (${o.source ?? "?"})`],
    [t("note.row.tier"), label("tier", o.tier)],
    [t("note.row.status"), statusDd],
    [t("note.row.validUntil"), o.valid_until ? timeEl(o.valid_until, { abs: true }) : null],
    [t("note.row.importance"), meter(o.importance)],
    [t("note.row.uses"), o.last_access_at ? t("note.usesLast", { n: num(o.access_count), when: fmtRel(o.last_access_at) }) : num(o.access_count)],
    [t("note.row.injections"), num(o.inject_count)],
    [t("note.row.repeats"), num(o.occurrence_count)],
    [t("note.row.tokens"), num(o.tokens)],
    [t("note.row.gitHead"), o.git_head ? h("span", { class: "app-mono", title: o.git_head }, o.git_head.slice(0, 12)) : null],
    ...metaRows,
    [t("note.row.transcript"), o.transcript_ref?.path ? h("span", { class: "app-mono" }, o.transcript_ref.path) : null],
  ]);

  const article = h(
    "article",
    { class: "app-detail", "aria-labelledby": "panel-title" },
    head,
    o.narrative ? section(t("note.description"), h("p", { class: "app-prose" }, o.narrative)) : null,
    facts.length ? section(t("note.facts"), h("ul", { class: "app-facts" }, facts.map((f) => h("li", null, f)))) : null,
    mod.length ? section(t("note.filesModifiedN", { n: mod.length }), fileList(mod)) : null,
    read.length ? section(t("note.filesReadN", { n: read.length }), fileList(read)) : null,
    concepts.length
      ? section(
          t("note.concepts"),
          h(
            "div",
            { class: "app-tags" },
            concepts.map((c) => h("span", { class: c.includes(":") ? "hx-tag app-tag--mono" : "hx-tag" }, c)),
          ),
        )
      : null,
    section(t("note.details"), details),
  );
  $("#panel-body").replaceChildren(article);
}

// ---------------------------------------------------------------------------
// 7. Na żywo: SSE /api/stream
// ---------------------------------------------------------------------------

const live = {
  es: null,
  state: "connecting",
  everOpened: false,
  retry: 0,
  errors: 0,
  timer: 0,
  recycleTimer: 0,
  statusTimer: 0,
  hiddenTimer: 0,
  paused: false,
  unseen: 0,
  queue: [],
  queueTimer: 0,
  changes: [],
  changesTimer: 0,
  // notatki ze zmienionym statusem do dociągnięcia (zdarzenie status niesie sam numer)
  fetchIds: new Set(),
  fetchTimer: 0,
  // kursor strumienia z ostatniego zdarzenia ("notatka-zmiana"): nowe połączenie dosyła to, co przeleciało w przerwie
  cursor: "",
};

// Worker (Bun, idleTimeout 120 s) zamyka strumień bez ruchu, a przeglądarka loguje wtedy błąd sieci.
// Dlatego po 100 s ciszy podgląd sam domyka połączenie i od razu otwiera nowe (bez błędu w konsoli).
// worker wysyła ping co 30 s; dłuższa cisza oznacza martwe połączenie
const LIVE_RECYCLE_MS = 75_000;

function connectLive() {
  if (gateReason) return;
  clearTimeout(live.timer);
  clearTimeout(live.recycleTimer);
  live.es?.close();
  let es;
  try {
    es = new EventSource(live.cursor ? `/api/stream?${qs({ since: live.cursor })}` : "/api/stream");
  } catch {
    applyLive("off");
    return;
  }
  live.es = es;
  const quiet = () => {
    clearTimeout(live.recycleTimer);
    live.recycleTimer = setTimeout(() => {
      if (live.es === es && es.readyState === EventSource.OPEN) connectLive();
    }, LIVE_RECYCLE_MS);
  };
  es.addEventListener("open", () => {
    const again = live.everOpened;
    live.everOpened = true;
    live.retry = 0;
    live.errors = 0;
    setLive("on");
    quiet();
    // po zerwaniu albo odświeżeniu połączenia dociągamy to, co mogło przelecieć bez nas
    if (again) void route.refresh?.();
  });
  es.addEventListener("hello", (e) => {
    quiet();
    try {
      const d = JSON.parse(e.data);
      if (d?.version) $("#app-version").textContent = d.version;
      // pierwsze połączenie: kursor od teraz (listy i tak wczytują stan z API)
      if (!live.cursor && typeof d?.cursor === "string") live.cursor = d.cursor;
    } catch {
      // zły hello nie przerywa strumienia
    }
  });
  es.addEventListener("ping", quiet);
  es.addEventListener("observation", (e) => {
    quiet();
    if (e.lastEventId) live.cursor = e.lastEventId;
    let o = null;
    try {
      o = JSON.parse(e.data);
    } catch {
      return;
    }
    if (o && typeof o.id === "number") onLiveObservation(o);
  });
  // zmiana statusu (scalenie, archiwum, zapomnienie, przywrócenie): z tej karty, innej karty, MCP albo snu.
  // Zdarzenie niesie tylko numer i status; notatkę dociągamy, gdy jest na ekranie
  es.addEventListener("status", (e) => {
    quiet();
    if (e.lastEventId) live.cursor = e.lastEventId;
    let c = null;
    try {
      c = JSON.parse(e.data);
    } catch {
      return;
    }
    if (c && typeof c.id === "number") onLiveStatus(c);
  });
  // masowa zmiana albo długa przerwa: worker przesunął kursor na koniec, widok i panel wczytujemy od nowa
  es.addEventListener("resync", (e) => {
    quiet();
    if (e.lastEventId) live.cursor = e.lastEventId;
    resyncView();
  });
  es.addEventListener("error", () => {
    if (es !== live.es) return;
    live.errors++;
    if (es.readyState === EventSource.CLOSED) {
      setLive("off");
      // przeglądarka zamyka strumień na stałe także po 401 (worker zamyka strumień z wygasłym ciasteczkiem, a ponowne
      // połączenie dostaje odmowę): wtedy ekran wejścia, nie ponawianie w kółko
      void sessionState().then((s) => {
        if (s === "none") showGate(hadSession ? "lost" : "missing");
      });
      live.timer = setTimeout(connectLive, Math.min(30_000, 2000 * 2 ** live.retry++));
    } else {
      // przeglądarka sama ponawia; po trzech nieudanych próbach z rzędu worker raczej leży
      setLive(live.errors >= 3 ? "off" : "connecting");
    }
  });
}

function setLive(s) {
  clearTimeout(live.statusTimer);
  // krótkie zerwania (np. limit bezczynności połączenia po stronie serwera) nie migają w pasku
  if (s === "connecting" && live.state === "on") {
    live.statusTimer = setTimeout(() => applyLive("connecting"), 5000);
    return;
  }
  applyLive(s);
}

function applyLive(s) {
  const prev = live.state;
  live.state = s;
  const el = $("#live");
  el.classList.remove("hx-badge--success", "hx-badge--warning", "hx-badge--error");
  el.classList.add({ on: "hx-badge--success", connecting: "hx-badge--warning", off: "hx-badge--error" }[s]);
  $(".app-live__text", el).textContent = { on: t("live.on"), connecting: t("live.connecting"), off: t("live.off") }[s];
  el.title = {
    on: t("live.onTitle"),
    connecting: t("live.connectingTitle"),
    off: t("live.offTitle"),
  }[s];
  if (s === "off" && prev !== "off") announce(t("live.lost"));
  if (s === "on" && prev === "off") announce(t("live.back"));
}

function onLiveObservation(o) {
  const handled = route.live?.(o) ?? false;
  if (o.status && o.status !== "active") return;
  if (state.project && !eqi(o.project, state.project)) return;
  if (route.view !== "strumien") setUnseen(live.unseen + 1);
  if (handled || route.view !== "strumien") {
    live.queue.push(o);
    clearTimeout(live.queueTimer);
    live.queueTimer = setTimeout(flushAnnouncements, 2500);
  }
}

function flushAnnouncements() {
  const q = live.queue.splice(0);
  if (!q.length) return;
  if (q.length === 1) announce(t("live.newNote", { title: q[0].title || t("note.noTitle") }));
  else announce(t("live.newNotes", { n: q.length }));
}

/** Zdarzenie status ({id, from, status}): notatki z ekranu zbieramy i dociągamy jednym zapytaniem. */
function onLiveStatus(c) {
  const status = c.status || "active";
  // echo własnej akcji: widok już zmieniony z odpowiedzi, komunikat z Cofnij już był
  if (ownChanges.get(c.id) === status) {
    ownChanges.delete(c.id);
    return;
  }
  const visible = panel.id === c.id || !!document.querySelector(`#view .note[data-id="${c.id}"]`) || !!route.wants?.(c.id, status);
  if (!visible) return;
  live.fetchIds.add(c.id);
  clearTimeout(live.fetchTimer);
  live.fetchTimer = setTimeout(() => void fetchChanged(), 150);
}

/** Bieżący stan notatek ze zmienionym statusem (tylko te na ekranie), potem widok i ogłoszenie. */
async function fetchChanged() {
  const ids = [...live.fetchIds];
  live.fetchIds.clear();
  if (!ids.length) return;
  let rows = [];
  try {
    rows = await api(`/api/observations?${qs({ ids: ids.join(",") })}`, { bg: true });
  } catch {
    return; // najlepsza próba: po zerwaniu i tak przyjdzie dosyłka albo resync
  }
  for (const o of Array.isArray(rows) ? rows : []) {
    if (!o || typeof o.id !== "number" || isStale(o)) continue;
    // ogłaszamy tylko notatki, które człowiek ma przed oczami i których stan na ekranie się zmienia
    const status = o.status || "active";
    const onScreen =
      (panel.id === o.id && !!panel.obs && (panel.obs.status || "active") !== status) ||
      !!document.querySelector(`#view .note[data-id="${o.id}"]:not([data-status="${CSS.escape(status)}"])`);
    applyStatus(o);
    if (onScreen) live.changes.push(o);
  }
  if (!live.changes.length) return;
  clearTimeout(live.changesTimer);
  live.changesTimer = setTimeout(flushChanges, 1500);
}

/** resync ze strumienia: bieżący widok i panel wczytane od nowa, bez przewijania na górę i bez kradzieży fokusu. */
function resyncView() {
  clearTimeout(live.fetchTimer);
  live.fetchIds.clear();
  // echa własnych zmian sprzed resync już nie przyjdą
  ownChanges.clear();
  rerenderQuietly();
  announce(t("live.resync"));
}

function flushChanges() {
  const q = live.changes.splice(0);
  if (!q.length) return;
  if (q.length === 1) announce(t("live.statusOne", { id: q[0].id, status: label("status", q[0].status || "active") }));
  else announce(t("live.statusMany", { n: q.length }));
}

function setUnseen(n) {
  live.unseen = n;
  const b = $("#unseen");
  b.hidden = n === 0;
  b.replaceChildren(n > 99 ? "99+" : String(n), h("span", { class: "hx-sr-only" }, ` ${t("live.unseen", { n })}`));
}

function initVisibility() {
  document.addEventListener("visibilitychange", () => {
    clearTimeout(live.hiddenTimer);
    if (document.hidden) {
      // karta w tle: po minucie zamykamy strumień, żeby nie trzymać workera przy życiu bez potrzeby
      live.hiddenTimer = setTimeout(() => {
        clearTimeout(live.recycleTimer);
        clearTimeout(live.timer);
        live.es?.close();
        live.es = null;
        live.paused = true;
      }, 60_000);
    } else if (live.paused || !live.es) {
      live.paused = false;
      connectLive();
    }
  });
}

// ---------------------------------------------------------------------------
// 8. Widok: Strumień
// ---------------------------------------------------------------------------

function viewStream(root, r, signal) {
  let types = parseTypes(r.params.get("typ"));
  // archiwum: ta sama lista z notatkami w archiwum (zapomniane i odłożone przez sen), z przyciskiem Przywróć
  let archive = r.params.get("archiwum") === "1";
  const shown = new Map(); // id -> created_at
  let cursor = null;
  let done = false;
  let pending = [];
  let loading = false;
  let loadCtrl = null;
  let loadGen = 0;

  const list = h("ol", { class: "app-list" });
  const box = h("div");
  const moreBtn = btn(t("stream.older"), { variant: "secondary", spinner: true });
  const footText = h("span");
  const foot = h("div", { class: "app-list-foot", hidden: true }, moreBtn, footText);
  const newBtn = btn("", { size: "sm" });
  const newBar = h("div", { class: "app-newbar", hidden: true }, newBtn);
  const head = viewHead(t("stream.kicker"), t("stream.title"), t("stream.lead"));
  const archiveSw = h("input", { class: "hx-switch", type: "checkbox", role: "switch" });
  archiveSw.checked = archive;
  archiveSw.addEventListener("change", () => {
    archive = archiveSw.checked;
    setParams({ archiwum: archive ? "1" : null });
    applyMode();
    reload();
  });

  /** Nagłówek i nazwa listy według trybu (najnowsze albo archiwum). */
  function applyMode() {
    $(".view-title", head).textContent = archive ? t("stream.archiveTitle") : t("stream.title");
    $(".view-lead", head).textContent = archive ? t("stream.archiveLead") : t("stream.lead");
    list.setAttribute("aria-label", archive ? t("stream.archiveListLabel") : t("stream.listLabel"));
  }
  applyMode();

  root.append(
    head,
    h(
      "div",
      { class: "app-toolbar" },
      projectField(() => reload()),
      typeFilter(types, (next) => {
        types = next;
        setParams({ typ: next.join(",") });
        reload();
      }),
      h("label", { class: "hx-choice app-archive-switch" }, archiveSw, h("span", null, t("stream.showArchive"))),
    ),
    newBar,
    box,
    list,
    foot,
  );

  moreBtn.addEventListener("click", () => load(false));
  newBtn.addEventListener("click", showPending);

  const filters = () => ({
    project: state.project || null,
    type: types.length ? types.join(",") : null,
    status: archive ? ARCHIVE_STATUSES.join(",") : null,
  });
  const rowOpts = (extra = {}) => ({ manage: true, expect: archive ? ARCHIVE_STATUSES.join(" ") : "active", ...extra });
  const inMode = (status) => (archive ? ARCHIVE_STATUSES.includes(status) : status === "active");

  function reload() {
    shown.clear();
    cursor = null;
    done = false;
    pending = [];
    newBar.hidden = true;
    list.replaceChildren();
    void load(true);
  }

  async function load(first) {
    // nowa lista (filtr, tryb archiwum) przerywa wczytywanie poprzedniej, inaczej spóźniona odpowiedź by ją zastąpiła
    if (loading && !first) return;
    loadCtrl?.abort();
    loadCtrl = new AbortController();
    const gen = ++loadGen;
    loading = true;
    setBusy(moreBtn, true);
    if (first) {
      foot.hidden = true;
      box.replaceChildren(loadingText(t("stream.loading")));
    }
    try {
      // kursor (created_at, id): notatki z tym samym czasem nie giną między stronami
      const rows = await api(`/api/recent?${qs({ ...filters(), limit: PAGE, before: cursor?.at ?? null, before_id: cursor?.id ?? null })}`, {
        signal: anySignal(signal, loadCtrl.signal),
      });
      const fresh = rows.filter((o) => !shown.has(o.id));
      for (const o of fresh) {
        list.append(noteRow(o, rowOpts()));
        shown.set(o.id, o.created_at);
      }
      if (rows.length) cursor = { at: rows[rows.length - 1].created_at, id: rows[rows.length - 1].id };
      done = rows.length < PAGE;
      box.replaceChildren();
      if (!shown.size) box.append(emptyStream());
      if (!first && fresh.length) announce(t("stream.added", { n: fresh.length }));
      updateFoot();
    } catch (e) {
      if (isAbort(e)) return;
      if (first) box.replaceChildren(errorAlert(e, reload));
      else toast(e.message);
    } finally {
      if (gen === loadGen) {
        loading = false;
        setBusy(moreBtn, false);
      }
    }
  }

  function emptyStream() {
    const filtered = !!(state.project || types.length);
    if (archive && !filtered) return emptyState(t("stream.archiveEmpty"), t("stream.archiveEmptyHint"));
    let action = null;
    if (filtered) {
      action = btn(t("stream.showAll"), { variant: "secondary", size: "sm" });
      action.addEventListener("click", () => {
        setProject("");
        const target = hashFor("strumien");
        if (types.length || location.hash !== target) location.hash = target;
        else reload();
      });
    }
    return emptyState(
      filtered ? t("stream.emptyFiltered") : t("stream.empty"),
      filtered ? t("stream.emptyFilteredHint") : t("stream.emptyHint"),
      action,
    );
  }

  function updateFoot() {
    foot.hidden = !shown.size;
    moreBtn.hidden = done;
    footText.textContent = done ? t("stream.end", { n: shown.size }) : "";
  }

  function insertLive(o, highlight) {
    const at = o.created_at ?? Date.now();
    let before = null;
    for (const li of list.children) {
      const c = shown.get(Number(li.dataset.id));
      if (c != null && c <= at) {
        before = li;
        break;
      }
    }
    if (!before && !done && shown.size) return false; // starsza niż wczytany zakres: przyjdzie z doładowaniem
    const li = noteRow(o, rowOpts({ isNew: highlight }));
    list.insertBefore(li, before);
    shown.set(o.id, at);
    box.replaceChildren();
    updateFoot();
    if (highlight) {
      setTimeout(() => {
        li.classList.remove("note--new");
        li.querySelector(".app-new")?.remove();
      }, 30_000);
    }
    return true;
  }

  function matches(o) {
    if (!inMode(o.status || "active")) return false;
    if (state.project && !eqi(o.project, state.project)) return false;
    if (types.length && !types.includes(o.type)) return false;
    return true;
  }

  function showPending() {
    const items = pending.splice(0);
    newBar.hidden = true;
    for (const o of items) {
      shown.delete(o.id);
      insertLive(o, true);
    }
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    list.querySelector(".note__link")?.focus({ preventScroll: true });
  }

  route.live = (o) => {
    if (!matches(o)) return false;
    if (shown.has(o.id)) return true;
    const top = list.firstElementChild;
    const newest = top ? shown.get(Number(top.dataset.id)) : null;
    const goesTop = newest == null || (o.created_at ?? 0) >= newest;
    if (goesTop && window.scrollY > 320) {
      pending.push(o);
      shown.set(o.id, o.created_at);
      newBtn.lastChild.textContent = t("stream.showNew", { n: pending.length });
      newBar.hidden = false;
      return true;
    }
    return insertLive(o, true);
  };

  // zmiana statusu: wiersze już na liście zmienia applyStatus (plakietka, przygaszenie, przycisk), a notatka, która
  // dopiero teraz pasuje do listy (przywrócona do najnowszych, zapomniana do archiwum), wchodzi na swoje miejsce
  route.status = (o) => {
    const i = pending.findIndex((p) => p.id === o.id);
    if (i >= 0) pending[i] = o;
    if (!shown.has(o.id) && matches(o)) insertLive(o, false);
  };
  // zdarzenie status dla notatki spoza ekranu: czekająca pod „Pokaż nowe” albo taka, która nowym statusem może tu pasować
  route.wants = (id, status) =>
    pending.some((p) => p.id === id) || (!shown.has(id) && inMode(status));

  route.refresh = async () => {
    try {
      const rows = await api(`/api/recent?${qs({ ...filters(), limit: PAGE })}`, { signal });
      for (const o of rows) if (!shown.has(o.id)) route.live?.(o);
    } catch {
      // dociągnięcie po zerwaniu jest najlepszą próbą
    }
  };

  void load(true);
}

// ---------------------------------------------------------------------------
// 9. Widok: Szukaj
// ---------------------------------------------------------------------------

function viewSearch(root, r, signal) {
  const st = {
    q: r.params.get("q") ?? "",
    types: parseTypes(r.params.get("typ")),
    od: r.params.get("od") ?? "",
    do: r.params.get("do") ?? "",
  };
  let timer = 0;
  let ctrl = null;

  const input = h("input", {
    class: "hx-input",
    id: "q",
    type: "search",
    name: "q",
    autocomplete: "off",
    spellcheck: "false",
    enterkeyhint: "search",
    placeholder: t("search.placeholder"),
    "aria-describedby": "q-help",
  });
  input.value = st.q;
  const form = h(
    "form",
    { class: "app-search", role: "search", "aria-label": t("search.formLabel") },
    h("div", { class: "hx-field" }, h("label", { class: "hx-label", for: "q" }, t("search.query")), input),
    btn(t("search.button"), { type: "submit" }),
    h("p", { class: "hx-help", id: "q-help" }, t("search.help")),
  );

  const dateField = (key, text) => {
    const id = uid(key);
    const el = h("input", { class: "hx-input", id, type: "date", value: st[key] || null });
    el.addEventListener("change", () => {
      st[key] = el.value;
      void run();
    });
    return h("div", { class: "hx-field app-field app-field--date" }, h("label", { class: "hx-label", for: id }, text), el);
  };

  const info = h("p", { class: "app-status", role: "status" });
  const box = h("div");
  const list = h("ol", { class: "app-list", "aria-label": t("search.resultsLabel") });

  root.append(
    viewHead(t("search.kicker"), t("search.title"), t("search.lead")),
    form,
    h(
      "div",
      { class: "app-toolbar" },
      projectField(() => run()),
      typeFilter(st.types, (next) => {
        st.types = next;
        void run();
      }),
      dateField("od", t("search.from")),
      dateField("do", t("search.to")),
    ),
    info,
    box,
    list,
  );

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 350);
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    clearTimeout(timer);
    void run();
  });
  route.cleanup = () => {
    clearTimeout(timer);
    ctrl?.abort();
  };

  async function run() {
    st.q = input.value.trim();
    lastSearch = st.q;
    setParams({ q: st.q, typ: st.types.join(","), od: st.od, do: st.do });
    ctrl?.abort();
    ctrl = new AbortController();
    const sig = anySignal(signal, ctrl.signal);
    if (st.q.length < 2) {
      list.replaceChildren();
      info.textContent = "";
      box.replaceChildren(
        emptyState(t("search.promptTitle"), t("search.promptHint")),
      );
      return;
    }
    box.replaceChildren();
    info.textContent = t("search.searching");
    const t0 = performance.now();
    try {
      const rows = await api(
        `/api/search?${qs({
          q: st.q,
          project: state.project || null,
          limit: 30,
          type: st.types.length ? st.types.join(",") : null,
          since: st.od ? `${st.od}T00:00:00` : null,
          until: st.do ? `${st.do}T23:59:59` : null,
        })}`,
        { signal: sig },
      );
      const ms = Math.round(performance.now() - t0);
      list.replaceChildren(
        ...rows.map((hit) =>
          noteRow(hit.observation, {
            manage: true,
            extra: relevance(hit.conf),
            scores: h(
              "span",
              { class: "app-scores", title: t("search.scoresTitle") },
              [hit.cos != null ? t("search.vector", { v: nf2.format(hit.cos) }) : null, hit.bm25 != null ? t("search.bm25", { v: nf2.format(hit.bm25) }) : null].filter(Boolean).join(" · "),
            ),
          }),
        ),
      );
      info.textContent = t("search.info", { n: rows.length, q: st.q, ms: num(ms) });
      if (!rows.length) {
        box.replaceChildren(emptyState(t("search.noResults"), t("search.noResultsHint")));
      }
    } catch (e) {
      if (isAbort(e)) return;
      info.textContent = "";
      list.replaceChildren();
      box.replaceChildren(errorAlert(e, run));
    }
  }

  void run();
}

// ---------------------------------------------------------------------------
// 10. Widoki: Sesje i Sesja
// ---------------------------------------------------------------------------

function sessionTitle(s) {
  return s.title || s.first_prompt || t("sessions.untitled");
}

function isLiveSession(s) {
  return s.status !== "ended" && s.last_activity_at && Date.now() - s.last_activity_at < 30 * 60_000;
}

function sessionRow(s, level = 2) {
  const end = s.ended_at || s.last_activity_at;
  return h(
    "li",
    { class: "note hx-chamfer hx-chamfer--line" },
    h(
      "div",
      { class: "note__top" },
      isLiveSession(s) ? toneBadge(t("sessions.live"), "success") : s.status === "ended" ? toneBadge(t("sessions.ended"), "") : null,
      s.source && s.source !== "live" ? h("span", { class: "hx-badge" }, s.source === "backfill" ? t("sessions.import") : s.source) : null,
    ),
    h(`h${level}`, { class: "note__title app-clamp" }, h("a", { class: "note__link", href: hashFor("sesja", s.id) }, sessionTitle(s))),
    h(
      "p",
      { class: "note__meta" },
      h("span", { class: "note__project" }, s.project),
      timeEl(s.started_at),
      end && end > s.started_at ? h("span", null, t("sessions.duration", { dur: fmtDur(end - s.started_at) })) : null,
      h("span", null, t("sessions.turns", { n: Number(s.prompt_count) || 0 })),
      s.git_branch ? h("span", { class: "app-mono" }, s.git_branch) : null,
      h("span", { class: "app-mono" }, s.id.slice(0, 8)),
    ),
  );
}

function viewSessions(root, r, signal) {
  let limit = 30;
  const list = h("ol", { class: "app-list", "aria-label": t("sessions.listLabel") });
  const box = h("div");
  const moreBtn = btn(t("sessions.more"), { variant: "secondary", spinner: true });
  const foot = h("div", { class: "app-list-foot", hidden: true }, moreBtn);
  root.append(
    viewHead(t("sessions.kicker"), t("sessions.title"), t("sessions.lead")),
    h(
      "div",
      { class: "app-toolbar" },
      projectField(() => {
        limit = 30;
        void load(true);
      }),
    ),
    box,
    list,
    foot,
  );
  moreBtn.addEventListener("click", () => {
    if (isBusy(moreBtn)) return;
    limit = Math.min(200, limit + 30);
    void load(false);
  });

  async function load(first) {
    setBusy(moreBtn, true);
    if (first) {
      list.replaceChildren();
      box.replaceChildren(loadingText(t("sessions.loading")));
    }
    try {
      const rows = await api(`/api/sessions?${qs({ project: state.project || null, limit })}`, { signal });
      list.replaceChildren(...rows.map((s) => sessionRow(s)));
      box.replaceChildren(rows.length ? "" : emptyState(t("sessions.empty"), state.project ? t("sessions.emptyProject") : t("sessions.emptyHint")));
      foot.hidden = rows.length < limit || limit >= 200;
    } catch (e) {
      if (isAbort(e)) return;
      box.replaceChildren(errorAlert(e, () => load(true)));
    } finally {
      setBusy(moreBtn, false);
    }
  }
  void load(true);
}

function viewSession(root, r, signal) {
  const id = r.arg;
  // przerysowanie po zmianie języka nie przenosi fokusu na tytuł (zostaje na przełączniku)
  const quiet = quietRender;
  const trail = (sid) => crumbs([[t("nav.sessions"), hashFor("sesje")], [t("session.crumb", { id: sid.slice(0, 8) })]]);
  root.append(trail(id), loadingText(t("session.loading")));

  (async () => {
    let data;
    try {
      data = await api(`/api/session/${encodeURIComponent(id)}`, { signal });
    } catch (e) {
      if (isAbort(e)) return;
      root.replaceChildren(
        trail(id),
        viewHead(t("session.kicker"), t("session.missing"), null),
        errorAlert(e, () => {
          root.replaceChildren();
          viewSession(root, r, signal);
        }),
      );
      return;
    }
    const { session: s, observations = [], summary } = data;
    const end = s.ended_at || s.last_activity_at;

    const info = h(
      "section",
      { class: "app-block hx-chamfer hx-chamfer--line", "aria-labelledby": "s-info" },
      h("h2", { class: "app-block__title", id: "s-info" }, t("session.info")),
      kv([
        [t("common.project"), s.project],
        [t("session.dir"), s.cwd ? h("span", { class: "app-mono" }, s.cwd) : null],
        [t("meta.branch"), s.git_branch ? h("span", { class: "app-mono" }, s.git_branch) : null],
        [t("session.start"), timeEl(s.started_at, { abs: true })],
        [s.ended_at ? t("session.end") : t("session.lastActivity"), end ? timeEl(end, { abs: true }) : null],
        [t("session.duration"), end && end > s.started_at ? fmtDur(end - s.started_at) : null],
        [t("session.turns"), num(s.prompt_count ?? 0)],
        [t("note.row.source"), s.source === "backfill" ? t("session.sourceBackfill") : s.source === "live" ? t("session.sourceLive") : s.source],
        [t("meta.model"), s.model],
        [t("session.id"), h("span", { class: "app-mono" }, s.id)],
      ]),
    );

    let sum = null;
    if (summary) {
      const pre = (text) => (text ? h("span", { class: "app-prose" }, text) : null);
      sum = h(
        "section",
        { class: "app-block hx-chamfer hx-chamfer--line", "aria-labelledby": "s-sum" },
        h(
          "div",
          { class: "app-block__head" },
          h("h2", { class: "app-block__title", id: "s-sum" }, t("session.summary")),
          summary.created_at ? h("span", { class: "hx-help" }, fmtDateTime(summary.created_at)) : null,
        ),
        kv([
          [t("session.request"), pre(summary.request)],
          [t("session.investigated"), pre(summary.investigated)],
          [t("session.learned"), pre(summary.learned)],
          [t("session.completed"), pre(summary.completed)],
          [t("session.nextSteps"), pre(summary.next_steps)],
          [t("session.notes"), pre(summary.notes)],
          [t("session.filesEdited"), toArr(summary.files_edited).length ? fileList(toArr(summary.files_edited), 15) : null],
          [t("session.filesRead"), toArr(summary.files_read).length ? fileList(toArr(summary.files_read), 15) : null],
        ]),
      );
    }

    const groups = new Map();
    for (const o of observations) {
      const k = o.prompt_n ?? 0;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }
    const turns = [...groups.entries()].sort((a, b) => turnOrder(a[0], b[0]));
    const notes = h(
      "section",
      { class: "app-gap", "aria-labelledby": "s-notes" },
      h("h2", { class: "app-block__title view-subtitle", id: "s-notes" }, t("session.notesByTurn", { n: observations.length })),
      observations.length
        ? turns.map(([n, obs]) =>
            h(
              "section",
              { class: "app-turn" },
              h("h3", { class: "app-turn__title" }, n ? turnLabel(n, true) : t("session.outsideTurns")),
              h("ol", { class: "app-list" }, obs.map((o) => noteRow(o, { level: 4 }))),
            ),
          )
        : emptyState(t("session.noNotes"), t("session.noNotesHint")),
    );

    root.replaceChildren();
    appendAll(
      root,
      trail(s.id),
      viewHead(t("session.kicker"), sessionTitle(s), `${s.project}, ${fmtDateTime(s.started_at)}`, { clamp: true }),
      info,
      sum,
      notes,
    );
    if (!firstRender && !pendingFocus && !quiet) $(".view-title", root)?.focus({ preventScroll: true });
  })().catch((e) => {
    if (isAbort(e) || signal.aborted) return;
    root.replaceChildren(trail(id), errorAlert(e));
  });
}

// ---------------------------------------------------------------------------
// 11. Widok: Projekty
// ---------------------------------------------------------------------------

function viewProjects(root, r, signal) {
  const list = h("ol", { class: "app-list app-projects", "aria-label": t("projects.listLabel") });
  const box = h("div", null, loadingText(t("projects.loading")));
  root.append(viewHead(t("projects.kicker"), t("projects.title"), t("projects.lead")), box, list);

  function render(rows) {
    const total = rows.reduce((a, p) => a + (Number(p.observations) || 0), 0);
    const lastAll = rows.reduce((a, p) => Math.max(a, Number(p.last_at) || 0), 0);
    const max = Math.max(1, ...rows.map((p) => Number(p.observations) || 0));
    const items = [{ project: "", label: t("common.allProjects"), observations: total, last_at: lastAll, all: true }, ...rows];
    list.replaceChildren(
      ...items.map((p) => {
        const selected = p.all ? !state.project : eqi(p.project, state.project);
        const pick = h("button", { class: "note__link", type: "button", "aria-pressed": String(selected) }, p.label ?? p.project);
        pick.addEventListener("click", () => {
          setProject(p.project);
          render(rows);
          toast(p.all ? t("projects.filterOff") : t("projects.filterOn", { project: p.project }));
          list.querySelector('[aria-pressed="true"]')?.focus();
        });
        const share = p.all ? 1 : (Number(p.observations) || 0) / max;
        return h(
          "li",
          { class: "note hx-chamfer hx-chamfer--line", "data-selected": selected ? "" : null },
          h(
            "div",
            { class: "app-section" },
            h("h2", { class: "note__title" }, pick),
            h(
              "p",
              { class: "note__meta" },
              h("span", null, t("common.notes", { n: Number(p.observations) || 0 })),
              p.last_at ? h("span", null, t("projects.last"), " ", timeEl(p.last_at)) : null,
            ),
          ),
          h(
            "div",
            { class: "app-section" },
            selected ? h("span", { class: "hx-badge hx-badge--gold" }, t("projects.selected")) : null,
            p.all ? null : h("span", { class: "app-rel" }, h("span", { class: "app-rel__bar", "aria-hidden": "true" }, setV(h("span", { class: "app-rel__fill" }), share)), h("span", { class: "app-rel__value" }, pct((Number(p.observations) || 0) / Math.max(1, total)))),
          ),
        );
      }),
    );
  }

  async function load() {
    box.replaceChildren(loadingText(t("projects.loading")));
    try {
      const rows = await api("/api/projects", { signal });
      state.projects = rows;
      refreshProjectSelects();
      box.replaceChildren(rows.length ? "" : emptyState(t("projects.empty"), t("projects.emptyHint")));
      if (rows.length) render(rows);
    } catch (e) {
      if (isAbort(e)) return;
      box.replaceChildren(errorAlert(e, load));
    }
  }
  void load();
}

// ---------------------------------------------------------------------------
// 12. Widok: Praca w toku (work state)
// ---------------------------------------------------------------------------

function wsStatus(s) {
  const k = String(s ?? "").toLowerCase();
  if (Object.hasOwn(WS_TONE, k)) return toneBadge(label("ws", k), WS_TONE[k]);
  return toneBadge(String(s ?? t("work.noStatus")), "");
}

function fieldsText(fields) {
  return Object.entries(fields ?? {})
    .filter(([k]) => k !== "status")
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("; ");
}

function viewWork(root, r, signal) {
  let closed = r.params.get("zamkniete") === "1";
  const sw = h("input", { class: "hx-switch", type: "checkbox", role: "switch", id: "ws-closed" });
  sw.checked = closed;
  sw.addEventListener("change", () => {
    closed = sw.checked;
    setParams({ zamkniete: closed ? "1" : null });
    void load();
  });
  const box = h("div");
  root.append(
    viewHead(t("work.kicker"), t("work.title"), t("work.lead")),
    h(
      "div",
      { class: "app-toolbar" },
      projectField(() => load(), { required: true }),
      h("label", { class: "hx-choice" }, sw, h("span", null, t("work.showClosed"))),
    ),
    box,
  );

  async function load() {
    if (!state.project) {
      box.replaceChildren(emptyState(t("work.pickProject"), t("work.pickProjectHint")));
      return;
    }
    box.replaceChildren(loadingText(t("work.loading")));
    try {
      const lists = await api(`/api/work-state?${qs({ project: state.project, closed: closed ? "1" : null })}`, { signal });
      if (!lists.length) {
        box.replaceChildren(
          emptyState(
            closed ? t("work.noneAll") : t("work.noneOpen"),
            closed ? t("work.noneAllHint") : t("work.noneOpenHint"),
          ),
        );
        return;
      }
      box.replaceChildren(...lists.map(workList));
      for (const wrap of box.querySelectorAll(".hx-table-wrap")) {
        if (wrap.scrollWidth > wrap.clientWidth) {
          wrap.setAttribute("tabindex", "0");
          wrap.setAttribute("role", "region");
          wrap.setAttribute("aria-label", wrap.dataset.label ?? t("work.tableLabel"));
        }
      }
    } catch (e) {
      if (isAbort(e)) return;
      box.replaceChildren(errorAlert(e, load));
    }
  }

  function workList(l) {
    const stateRows = Object.entries(l.state ?? {})
      .filter(([k]) => k !== "status")
      .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
    const items = l.items ?? [];
    const th = (text, cls) => h("th", { scope: "col", class: cls ?? null }, text);
    const table = items.length
      ? h(
          "div",
          { class: "hx-table-wrap app-table-region", "data-label": t("work.tasksOf", { name: l.name }) },
          h(
            "table",
            { class: "hx-table hx-table--compact" },
            h("caption", { class: "hx-sr-only" }, t("work.tasksOf", { name: l.name })),
            h("thead", null, h("tr", null, th(t("work.colTask")), th(t("work.colStatus")), th(t("work.colDetails")), th(t("work.colUpdated"), "hx-num"))),
            h(
              "tbody",
              null,
              items.map((it) =>
                h(
                  "tr",
                  null,
                  h("td", null, it.task),
                  h("td", null, wsStatus(it.status)),
                  h("td", null, fieldsText(it.fields) || ""),
                  h("td", { class: "hx-num" }, timeEl(it.updatedAt)),
                ),
              ),
            ),
          ),
        )
      : h("p", { class: "hx-help" }, t("work.noTasks"));
    return h(
      "section",
      { class: "app-block hx-chamfer hx-chamfer--line", "aria-label": t("work.listOf", { name: l.name }) },
      h(
        "div",
        { class: "app-block__head" },
        h("h2", { class: "app-block__title" }, l.name),
        h("span", { class: "hx-cluster" }, l.closed ? toneBadge(t("work.listClosed"), "") : toneBadge(t("work.listOpen"), "info"), h("span", { class: "hx-help" }, t("work.updated"), " ", timeEl(l.updatedAt))),
      ),
      stateRows.length ? h("div", { class: "app-ws-state" }, kv(stateRows)) : null,
      table,
    );
  }

  void load();
}

// ---------------------------------------------------------------------------
// 13. Widok: Statystyki
// ---------------------------------------------------------------------------

function viewStats(root, r, signal) {
  const box = h("div", null, loadingText(t("stats.loading")));
  const workerBox = h("div");
  let uptimeTimer = 0;
  route.cleanup = () => clearInterval(uptimeTimer);

  const sleepOut = h("div", { class: "app-sleep__result" });
  const sleepBtn = btn(t("stats.sleepRun"), { spinner: true });
  sleepBtn.addEventListener("click", runSleep);
  const sleepBlock = h(
    "section",
    { class: "app-block hx-chamfer hx-chamfer--line app-gap", "aria-labelledby": "sleep-title" },
    h("h2", { class: "app-block__title", id: "sleep-title" }, t("stats.sleepTitle")),
    h("p", { class: "view-lead" }, t("stats.sleepLead")),
    h("div", { class: "app-sleep__actions" }, sleepBtn),
    sleepOut,
  );

  root.append(viewHead(t("stats.kicker"), t("stats.title"), t("stats.lead")), box, sleepBlock);

  async function load() {
    const [stats, health] = await Promise.allSettled([api("/api/stats", { signal }), api("/api/health", { signal })]);
    if (signal.aborted) return;
    if (stats.status === "rejected") {
      box.replaceChildren(errorAlert(stats.reason, load));
      return;
    }
    box.replaceChildren(...renderStats(stats.value, health.status === "fulfilled" ? health.value : null, health.status === "rejected" ? health.reason : null));
  }

  function renderStats(s, hl, hErr) {
    // embed.enabled = false: model się nie wczyta, brakujących wektorów nikt nie policzy
    const vecOff = hl?.embedder?.device === DEVICE_OFF;
    const cost = Number(s.llmCostUsd) || 0;
    const costCard = h(
      "section",
      { class: "app-cost hx-chamfer hx-chamfer--line", "aria-labelledby": "cost-title" },
      h(
        "div",
        { class: "app-cost__text" },
        h("h2", { class: "app-cost__title", id: "cost-title" }, t("stats.costTitle")),
        h("p", { class: "app-cost__note" }, t("stats.costNote")),
      ),
      h("p", { class: "app-cost__value" }, cost ? nf2.format(cost) : "0", h("span", { class: "app-cost__unit" }, cost ? "USD" : t("stats.costZeroUnit"))),
    );

    const tile = (text, value, sub) =>
      h(
        "div",
        { class: "hx-stat" },
        h("p", { class: "hx-stat__value" }, num(value)),
        h("p", { class: "hx-stat__label" }, text),
        sub ? h("p", { class: "app-stat__sub" }, sub) : null,
      );
    const tiles = h(
      "div",
      { class: "app-stats" },
      tile(t("stats.active"), s.active, t("stats.ofTotal", { n: Number(s.observations) || 0 })),
      tile(t("stats.sessions"), s.sessions),
      tile(t("stats.summaries"), s.summaries),
      tile(t("stats.prompts"), s.prompts),
      tile(t("stats.projects"), s.projects),
      tile(t("stats.vectors"), s.vectors, vecOff ? t("stats.vectorsOff") : s.missingVectors ? t("stats.vectorsMissing", { n: Number(s.missingVectors) || 0 }) : t("stats.complete")),
      tile(t("stats.entities"), s.entities, t("stats.entitiesSub")),
      tile(t("stats.injections"), s.injections, t("stats.sinceStart")),
    );

    const byType = (s.byType ?? []).map((row) => ({ label: row.type == null ? t("common.noType") : typeLabel(row.type), title: row.type, value: row.c }));
    const bySource = (s.bySource ?? []).map((row) => ({ label: label("source", row.source, row.source ?? "?"), title: row.source, value: row.c }));
    const inj = s.injections7d ?? [];
    const injTotal = inj.reduce((a, x) => a + (Number(x.n) || 0), 0);
    const injTokens = inj.reduce((a, x) => a + (Number(x.t) || 0), 0);

    const block = (title, ...content) =>
      h("section", { class: "app-block hx-chamfer hx-chamfer--line" }, h("h2", { class: "app-block__title" }, title), ...content);

    const panels = h(
      "div",
      { class: "app-panels" },
      block(t("stats.byType"), byType.length ? barChart(byType, t("stats.byTypeLabel")) : h("p", { class: "hx-help" }, t("stats.noNotes"))),
      block(t("stats.bySource"), bySource.length ? barChart(bySource, t("stats.bySourceLabel")) : h("p", { class: "hx-help" }, t("stats.noNotes"))),
      block(
        t("stats.inj7"),
        injTotal
          ? barChart(
              inj.map((x) => ({ label: label("channel", x.channel), title: x.channel, value: x.n })),
              t("stats.injByChannelLabel"),
            )
          : h("p", { class: "hx-help" }, t("stats.noInj7")),
        kv([
          [t("stats.total"), num(injTotal)],
          [t("stats.tokens"), num(injTokens)],
          [
            t("stats.usedAfter"),
            t("stats.usedAfterValue", {
              notes: t("common.notes", { n: Number(s.usedAfterInjection7d) || 0 }),
              inj: t("stats.injectionsOf", { n: injTotal }),
            }),
          ],
        ]),
      ),
      block(
        t("stats.indexQueue"),
        kv([
          [t("stats.vectors"), num(s.vectors)],
          [
            t("stats.missingVectors"),
            vecOff
              ? t("stats.notCounted")
              : s.missingVectors
                ? toneBadge(t("stats.queued", { n: Number(s.missingVectors) || 0 }), "warning")
                : toneBadge(t("stats.complete"), "success"),
          ],
          [t("stats.pendingJobs"), num(s.pendingJobs)],
          [t("stats.failedJobs"), s.failedJobs ? toneBadge(num(s.failedJobs), "error") : "0"],
          [t("stats.entities"), num(s.entities)],
        ]),
      ),
      workerBlock(hl, hErr),
    );
    return [costCard, tiles, panels];
  }

  function workerBlock(hl, err) {
    clearInterval(uptimeTimer);
    if (!hl) return h("section", { class: "app-block hx-chamfer hx-chamfer--line" }, h("h2", { class: "app-block__title" }, t("stats.worker")), errorAlert(err ?? new Error(t("stats.noData")), load));
    const fetchedAt = Date.now();
    const uptime = h("span", null, fmtDur((hl.uptimeS ?? 0) * 1000));
    uptimeTimer = setInterval(() => {
      uptime.textContent = fmtDur((hl.uptimeS ?? 0) * 1000 + (Date.now() - fetchedAt));
    }, 30_000);
    const emb = hl.embedder ?? {};
    workerBox.replaceChildren(
      h("h2", { class: "app-block__title" }, t("stats.worker")),
      kv([
        [t("stats.state"), hl.ok ? toneBadge(t("stats.running"), "success") : toneBadge(t("stats.problem"), "warning")],
        [t("stats.version"), hl.version],
        [t("stats.pid"), String(hl.pid ?? "")],
        [t("stats.uptime"), uptime],
        [t("meta.model"), emb.model ? h("span", { class: "app-mono" }, emb.model) : null],
        [t("stats.device"), label("device", emb.device === DEVICE_OFF ? "off" : emb.device, emb.device)],
        [t("stats.modelLoaded"), emb.loaded ? t("common.yes") : emb.device === DEVICE_OFF ? t("stats.modelOff") : t("stats.modelLazy")],
        [t("stats.vectorsSinceStart"), num(hl.embedded)],
        // starszy worker nie podaje pętli ani kolejki: wiersze znikają (kv pomija null)
        [
          t("stats.eventLoop"),
          hl.eventLoopLagMs == null
            ? null
            : hl.eventLoopLagMaxMs > 1000
              ? toneBadge(t("stats.lag", { ms: num(hl.eventLoopLagMs), max: num(hl.eventLoopLagMaxMs) }), "warning")
              : t("stats.lag", { ms: num(hl.eventLoopLagMs), max: num(hl.eventLoopLagMaxMs) }),
        ],
        [t("stats.pendingJobs"), hl.pendingJobs == null ? null : num(hl.pendingJobs)],
      ]),
    );
    workerBox.className = "app-block hx-chamfer hx-chamfer--line";
    workerBox.setAttribute("aria-label", t("stats.worker"));
    return workerBox;
  }

  async function runSleep() {
    if (isBusy(sleepBtn)) return;
    setBusy(sleepBtn, true);
    sleepOut.replaceChildren(loadingText(t("stats.sleeping")));
    try {
      const rep = await api("/api/admin/sleep", { method: "POST" });
      sleepOut.replaceChildren(
        h(
          "div",
          { class: "hx-alert hx-alert--success", role: "status" },
          h("p", { class: "hx-alert__title" }, t("stats.sleepDone", { ms: num(rep?.ms) })),
          h(
            "p",
            { class: "hx-alert__body" },
            t("stats.sleepReport", {
              merged: num(rep?.merged),
              archived: num(rep?.archived),
              access: num(rep?.prunedAccess),
              injections: num(rep?.prunedInjections),
            }),
          ),
        ),
      );
      if (!signal.aborted) void load();
    } catch (e) {
      sleepOut.replaceChildren(errorAlert(e, runSleep));
    } finally {
      setBusy(sleepBtn, false);
    }
  }

  void load();
}

// ---------------------------------------------------------------------------
// 14. Widok: Oś czasu
// ---------------------------------------------------------------------------

function viewTimeline(root, r, signal) {
  const id = Number(String(r.arg).replace(/^#/, ""));
  const clampInt = (v, d) => Math.max(1, Math.min(50, Number.parseInt(v ?? "", 10) || d));
  let before = clampInt(r.params.get("przed"), 6);
  let after = clampInt(r.params.get("po"), 6);
  let first = true;

  const earlier = btn(t("timeline.earlier"), { variant: "secondary", size: "sm", spinner: true });
  const later = btn(t("timeline.later"), { variant: "secondary", size: "sm", spinner: true });
  const list = h("ol", { class: "app-tl", "aria-label": t("timeline.listLabel") });
  const box = h("div", null, loadingText(t("timeline.loading")));
  const lead = h("p", { class: "view-lead" });
  const head = viewHead(t("timeline.kicker"), t("timeline.around", { id: Number.isFinite(id) ? id : "?" }), null);
  head.append(lead);
  root.append(
    crumbs([[t("nav.stream"), hashFor("strumien")], [t("timeline.crumb", { id })]]),
    head,
    h("div", { class: "app-tl__controls" }, earlier),
    box,
    list,
    h("div", { class: "app-tl__controls app-tl__controls--end" }, later),
  );

  earlier.addEventListener("click", () => {
    if (isBusy(earlier) || before >= 50) return;
    before = Math.min(50, before + 10);
    setParams({ przed: before });
    void load(earlier);
  });
  later.addEventListener("click", () => {
    if (isBusy(later) || after >= 50) return;
    after = Math.min(50, after + 10);
    setParams({ po: after });
    void load(later);
  });

  function item(it) {
    const time = h("p", { class: "app-tl__time" }, timeEl(it.at, { abs: true }));
    if (it.kind === "observation") {
      const anchor = !!it.anchor;
      return h(
        "li",
        { class: `app-tl__item${anchor ? " app-tl__item--anchor" : ""}` },
        time,
        noteRow(it.obs, { tag: "div", level: 2, extra: anchor ? h("span", { class: "hx-badge hx-badge--gold" }, t("timeline.anchor")) : null }),
      );
    }
    if (it.kind === "prompt") {
      const text = h("p", { class: "app-tl__text", "data-clamped": "true" }, it.text ?? "");
      const long = (it.text ?? "").length > 320 || (it.text ?? "").split("\n").length > 4;
      const toggle = long ? btn(t("timeline.showAll"), { variant: "ghost", size: "sm" }) : null;
      toggle?.addEventListener("click", () => {
        const clamped = text.dataset.clamped === "true";
        text.dataset.clamped = String(!clamped);
        toggle.lastChild.textContent = clamped ? t("timeline.collapse") : t("timeline.showAll");
        toggle.setAttribute("aria-expanded", String(clamped));
      });
      toggle?.setAttribute("aria-expanded", "false");
      if (!long) text.dataset.clamped = "false";
      return h(
        "li",
        { class: "app-tl__item" },
        time,
        h(
          "div",
          { class: "app-tl__prompt" },
          h(
            "p",
            { class: "hx-label" },
            it.n != null && promptRef(it.n).kind !== "turn"
              ? `${t("session.request")}, ${turnLabel(it.n)}`
              : `${t("session.request")} ${it.n ?? ""}`.trim(),
          ),
          text,
          toggle,
          it.session_id ? h("a", { class: "hx-link app-mono", href: hashFor("sesja", it.session_id) }, t("timeline.sessionLink", { id: it.session_id.slice(0, 8) })) : null,
        ),
      );
    }
    if (it.kind === "summary") {
      const s = it.summary ?? {};
      return h(
        "li",
        { class: "app-tl__item" },
        time,
        h(
          "div",
          { class: "app-block hx-chamfer hx-chamfer--line" },
          h("p", { class: "hx-label" }, t("timeline.sessionSummary")),
          kv([
            [t("session.request"), s.request],
            [t("session.completed"), s.completed],
            [t("session.nextSteps"), s.next_steps],
          ]),
          s.session_id ? h("a", { class: "hx-link", href: hashFor("sesja", s.session_id) }, t("timeline.openSession")) : null,
        ),
      );
    }
    return null;
  }

  async function load(trigger) {
    if (trigger) setBusy(trigger, true);
    try {
      const data = await api(`/api/timeline?${qs({ anchor: id, before, after })}`, { signal });
      if (!data?.anchor) {
        box.replaceChildren(emptyState(t("timeline.missing", { id }), t("timeline.missingHint")));
        list.replaceChildren();
        return;
      }
      lead.textContent = `${data.anchor.project}: ${data.anchor.title}`;
      box.replaceChildren();
      list.replaceChildren(...(data.items ?? []).map(item).filter(Boolean));
      const obsBefore = (data.items ?? []).filter((x) => x.kind === "observation" && x.at < data.anchor.created_at).length;
      const obsAfter = (data.items ?? []).filter((x) => x.kind === "observation" && x.at > data.anchor.created_at).length;
      earlier.parentElement.hidden = earlier.hidden = obsBefore < before || before >= 50;
      later.parentElement.hidden = later.hidden = obsAfter < after || after >= 50;
      if (first) {
        first = false;
        list.querySelector(".app-tl__item--anchor")?.scrollIntoView({ block: "center" });
      }
    } catch (e) {
      if (isAbort(e)) return;
      box.replaceChildren(errorAlert(e, () => load()));
    } finally {
      if (trigger) setBusy(trigger, false);
    }
  }
  void load();
}

// ---------------------------------------------------------------------------
// 15. Start: język, motyw, klawisze, kliknięcia, router, strumień na żywo
// ---------------------------------------------------------------------------

/** Stała rama z index.html i atrybuty dokumentu w bieżącym języku; przełącznik PL/EN tylko gdy wolno wybierać. */
function applyChrome() {
  document.documentElement.lang = lang;
  $('meta[name="description"]')?.setAttribute("content", t("brand.description"));
  applyStatic(document, t);
  const box = $("#lang");
  box.hidden = !canChooseLang;
  for (const b of box.querySelectorAll("button[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
}

/** Zmiana języka na żywo, bez przeładowania: ramka, formaty, pigułka, licznik, panel i bieżący widok. */
function setLang(next) {
  if (next === lang || !LANGS.includes(next)) return;
  lang = next;
  writeStore(STORE_LANG, next);
  // jawny wybór przyciskiem wygrywa z ?lang= z adresu (inaczej odświeżenie cofnęłoby język)
  try {
    const url = new URL(location.href);
    if (url.searchParams.has("lang")) {
      url.searchParams.delete("lang");
      history.replaceState(history.state, "", url);
    }
  } catch {
    // adres zostaje bez zmian
  }
  I18N = createI18n(next, DICTS);
  buildFormats();
  applyChrome();
  applyLive(live.state);
  setUnseen(live.unseen);
  refreshProjectSelects();
  rerenderQuietly();
}

/**
 * Bieżący widok i otwarty panel od nowa, bez przewijania na górę. Fokus zostaje, gdzie był; jeśli był w treści,
 * która znika, idzie na tytuł widoku albo panelu (nie na body).
 */
function rerenderQuietly() {
  const active = document.activeElement;
  const inView = !!(active && $("#view").contains(active));
  const inPanel = !!(active && $("#panel-body").contains(active));
  quietRender = true;
  try {
    route.key = null;
    onRoute();
  } finally {
    quietRender = false;
  }
  if (inView) $(".view-title", $("#view"))?.focus({ preventScroll: true });
  if (panel.id != null) void loadPanel(panel.id, { quiet: !inPanel });
}

function initLang() {
  $("#lang").addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("button[data-lang]") : null;
    if (b) setLang(b.dataset.lang);
  });
}

function initTheme() {
  const sw = $("#theme-switch");
  sw.checked = document.documentElement.getAttribute("data-theme") === "light";
  sw.addEventListener("change", () => {
    const mode = sw.checked ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", mode);
    writeStore(STORE_THEME, mode);
    $('meta[name="theme-color"]')?.setAttribute("content", mode === "light" ? "#F6F3EC" : "#0A0A0C");
  });
}

function isTyping(el) {
  return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function focusSearch() {
  if (route.view === "szukaj") {
    const q = $("#q");
    q?.focus();
    q?.select();
    return;
  }
  pendingFocus = "#q";
  location.hash = hashFor("szukaj", null, lastSearch ? { q: lastSearch } : null);
}

function initKeys() {
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    // otwarte okno dialogowe samo obsługuje Esc; skróty widoku nie działają pod nim
    if (document.querySelector("dialog[open]")) return;
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
      e.preventDefault();
      focusSearch();
      return;
    }
    if (e.key === "Escape" && panel.id != null) {
      e.preventDefault();
      closePanel();
    }
  });
}

function initClicks() {
  // jeden nasłuch dla wszystkich linków do notatek: zwykłe kliknięcie otwiera panel, Ctrl/środkowy otwiera kartę
  document.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[data-note]") : null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const id = Number(a.dataset.note);
    if (!Number.isInteger(id) || id <= 0) return;
    e.preventDefault();
    openNote(id);
  });
  $("#panel-close").addEventListener("click", closePanel);
}

function refreshRelTimes() {
  for (const el of document.querySelectorAll("time[data-ms]")) el.textContent = fmtRel(Number(el.dataset.ms));
}

async function init() {
  // ?projekt=X ustawia filtr tylko na to otwarcie (link, zrzut ekranu), bez zapisywania wyboru
  let fromQuery = null;
  try {
    fromQuery = new URLSearchParams(location.search).get("projekt");
  } catch {
    fromQuery = null;
  }
  state.project = fromQuery ?? readStore(STORE_PROJECT);
  // rama w wybranym języku zanim narysuje się pierwszy widok
  applyChrome();
  applyLive(live.state);
  initLang();
  initTheme();
  initKeys();
  initClicks();
  initToast();
  initVisibility();
  window.addEventListener("hashchange", onRoute);
  MOBILE.addEventListener("change", applyPanelMode);
  // bez ciasteczka podglądu (T-34) zamiast widoków ekran wejścia; ?auth=invalid: worker odrzucił bilet
  const authParam = takeAuthParam();
  if ((await sessionState()) === "none") return showGate(authParam === "invalid" ? "invalid" : "missing");
  onRoute();
  void loadProjects();
  connectLive();
  setInterval(refreshRelTimes, 60_000);
}

void init();
