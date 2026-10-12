// hipokamp: widok Dashboard, strona startowa podglądu. Widżety: kafelki liczb, zbiorcze TODO ze wszystkich
// projektów (praca w toku), aktywność dzień po dniu, projekty, ostatnie notatki i sesje, stan workera.
// Treść z bazy trafia do DOM wyłącznie jako tekst (bez innerHTML). Pomocnicze funkcje i stan podglądu
// (h, btn, api, t, noteRow…) dostajemy z app.js w obiekcie `kit`, żeby nie dublować kodu i nie robić cyklu importów.
import {
  fieldsText,
  filterItems,
  fold,
  flattenWork,
  groupByList,
  groupByProject,
  groupByStatus,
  isOpen,
  OPEN_CATS,
  isStale,
  sortItems,
  statusCat,
  summarize,
  toMarkdown,
} from "./dashboard-model.js";

let K = null; // kit z app.js, ustawiany przy każdym wejściu w widok
const t = (key, params) => K.t(key, params);
const h = (...a) => K.h(...a);

const STORE = "hipokamp:dash";
const WIDGETS = ["kpi", "todo", "activity", "projects", "recent", "sessions", "system"];
const WIDGET_LABEL = {
  kpi: "dash.w.kpi",
  todo: "dash.w.todo",
  activity: "dash.w.activity",
  projects: "dash.w.projects",
  recent: "dash.w.recent",
  sessions: "dash.w.sessions",
  system: "dash.w.system",
};
const GROUPS = { project: "dash.group.project", status: "dash.group.status", flat: "dash.group.flat" };
const FILTERS = {
  all: "dash.f.open",
  blocked: "dash.status.blocked",
  doing: "dash.status.doing",
  todo: "dash.status.todo",
  done: "dash.f.completed",
};
const STATUS_LABEL = {
  todo: "dash.status.todo",
  doing: "dash.status.doing",
  blocked: "dash.status.blocked",
  done: "dash.status.done",
  dropped: "dash.status.dropped",
};
const TONE = { blocked: "warning", doing: "info", todo: "", done: "success", dropped: "" };
const DAYS = [7, 14, 30];
const CAP = 25; // pozycji na grupę, reszta po kliknięciu „Pokaż więcej”
const REFRESH_MS = 60_000;
const STATUS_DEBOUNCE_MS = 600; // zmiana statusu strzałkami na liście nie zapisuje po drodze każdej wartości
// które widżety zależą od których źródeł danych (przerysowujemy tylko te, w których coś się zmieniło)
const DEPENDS = {
  stats: ["kpi", "system"],
  health: ["kpi", "system"],
  lists: ["kpi", "todo", "projects"],
  activity: ["kpi", "activity"],
  recent: ["kpi", "recent"],
  sessions: ["kpi", "sessions"],
  projects: ["todo", "projects"],
};
// pola, które zmieniają się przy każdym odczycie i same nie uzasadniają przerysowania
const VOLATILE_HEALTH = ["uptimeS", "eventLoopLagMs", "eventLoopLagMaxMs", "embedded", "pid"];

const statusLabel = (cat) => t(STATUS_LABEL[cat] ?? STATUS_LABEL.todo);

function defaultPrefs() {
  return {
    widgets: Object.fromEntries(WIDGETS.map((w) => [w, true])),
    group: "project",
    status: "all",
    stale: false,
    project: "",
    days: 14,
    collapsed: [],
  };
}

/** Ustawienia widoku z localStorage; uszkodzony zapis albo nieznane wartości dają ustawienia domyślne. */
function loadPrefs() {
  const p = defaultPrefs();
  try {
    const s = JSON.parse(K.readStore(STORE) || "{}");
    if (s && typeof s === "object") {
      if (s.widgets && typeof s.widgets === "object") for (const w of WIDGETS) if (typeof s.widgets[w] === "boolean") p.widgets[w] = s.widgets[w];
      if (Object.hasOwn(GROUPS, s.group)) p.group = s.group;
      if (Object.hasOwn(FILTERS, s.status)) p.status = s.status;
      if (typeof s.stale === "boolean") p.stale = s.stale;
      if (typeof s.project === "string") p.project = s.project.slice(0, 200);
      if (DAYS.includes(s.days)) p.days = s.days;
      if (Array.isArray(s.collapsed)) p.collapsed = s.collapsed.filter((x) => typeof x === "string").slice(0, 100);
    }
  } catch {
    // zostają ustawienia domyślne
  }
  return p;
}

const same = (a, b) => fold(a) === fold(b);

export function viewDashboard(root, r, signal, kit) {
  K = kit;
  const prefs = loadPrefs();
  const save = () => K.writeStore(STORE, JSON.stringify(prefs));
  const data = { stats: null, health: null, lists: null, activity: null, recent: null, sessions: null, projects: null };
  const errs = {};
  let work = { items: [], contexts: [] };
  let query = "";
  const sigs = {}; // sygnatura ostatnio narysowanych danych per źródło
  const dirty = new Set(); // widżety do przerysowania, gdy fokus z nich wyjdzie (odświeżenie w tle go nie zabiera)
  const pending = new Map(); // zmiany statusu czekające na debounce: klucz pozycji -> { timer, run }
  let writes = 0; // zapisy w toku
  let writeSeq = 0; // licznik zakończonych zapisów: odczyt rozpoczęty przed zapisem nie nadpisuje stanu po nim
  let lastLoadAt = 0;
  let timer = 0;
  const expanded = new Set(); // grupy rozwinięte ponad limit CAP (tylko do zamknięcia widoku)

  const slots = Object.fromEntries(WIDGETS.map((w) => [w, h("section", { class: `dash-widget dash-widget--${w}`, "data-widget": w })]));
  const applyVisibility = () => {
    for (const w of WIDGETS) slots[w].hidden = !prefs.widgets[w];
  };
  const widgetBlock = (name, titleKey, ...content) => {
    const id = uid(`dash-${name}`);
    slots[name].setAttribute("aria-labelledby", id);
    return [h("div", { class: "app-block__head" }, h("h2", { class: "app-block__title", id }, t(titleKey))), ...content];
  };
  const uid = (p) => K.uid(p);

  // -------------------------------------------------------------------------
  // Nagłówek: szukaj, odśwież, dostosuj
  // -------------------------------------------------------------------------

  const qInput = h("input", {
    class: "hx-input",
    id: "dash-q",
    type: "search",
    autocomplete: "off",
    spellcheck: "false",
    enterkeyhint: "search",
    placeholder: t("dash.search.placeholder"),
    "aria-label": t("dash.search.label"),
  });
  const searchForm = h("form", { class: "dash-search", role: "search", "aria-label": t("dash.search.label") }, qInput, K.btn(t("dash.search.go"), { type: "submit" }));
  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = qInput.value.trim();
    location.hash = K.hashFor("szukaj", null, q ? { q } : null);
  });

  const refreshBtn = K.btn(t("dash.refresh"), { variant: "secondary", size: "sm", spinner: true });
  refreshBtn.addEventListener("click", () => void load({ manual: true }));
  const customizeBtn = K.btn(t("dash.customize"), { variant: "ghost", size: "sm" });
  customizeBtn.setAttribute("aria-expanded", "false");
  customizeBtn.setAttribute("aria-controls", "dash-custom");

  const customPanel = h("div", { class: "dash-custom hx-chamfer hx-chamfer--line", id: "dash-custom", hidden: true });
  function buildCustom() {
    const resetBtn = K.btn(t("dash.custom.reset"), { variant: "ghost", size: "sm" });
    resetBtn.addEventListener("click", () => {
      Object.assign(prefs, defaultPrefs(), { collapsed: prefs.collapsed });
      save();
      applyVisibility();
      syncTodoControls();
      buildCustom();
      paint(WIDGETS);
    });
    customPanel.replaceChildren(
      h("p", { class: "dash-custom__title" }, t("dash.custom.title")),
      h(
        "div",
        { class: "dash-custom__list" },
        WIDGETS.map((w) => {
          const sw = h("input", { class: "hx-switch", type: "checkbox", role: "switch" });
          sw.checked = prefs.widgets[w];
          sw.addEventListener("change", () => {
            prefs.widgets[w] = sw.checked;
            save();
            applyVisibility();
            paint(WIDGETS);
          });
          return h("label", { class: "hx-choice" }, sw, h("span", null, t(WIDGET_LABEL[w])));
        }),
      ),
      h("p", { class: "hx-help" }, t("dash.custom.help")),
      resetBtn,
    );
  }
  customizeBtn.addEventListener("click", () => {
    const open = customPanel.hidden;
    customPanel.hidden = !open;
    customizeBtn.setAttribute("aria-expanded", String(open));
  });

  // -------------------------------------------------------------------------
  // Dane
  // -------------------------------------------------------------------------

  const sources = {
    stats: (o) => K.api("/api/stats", { signal, ...o }),
    health: (o) => K.api("/api/health", { signal, ...o }),
    lists: (o) => K.api("/api/work-state/all?closed=1", { signal, ...o }),
    activity: (o) => K.api("/api/activity?days=30", { signal, ...o }),
    recent: (o) => K.api(`/api/recent?${K.qs({ limit: 6 })}`, { signal, ...o }),
    sessions: (o) => K.api(`/api/sessions?${K.qs({ limit: 5 })}`, { signal, ...o }),
    projects: (o) => K.api("/api/projects", { signal, ...o }),
  };

  function sigOf(key, value) {
    if (key === "health" && value && typeof value === "object") {
      const rest = { ...value };
      for (const f of VOLATILE_HEALTH) delete rest[f];
      return JSON.stringify(rest);
    }
    return JSON.stringify(value);
  }

  /**
   * Pobiera wszystko równolegle. quiet = odświeżenie w tle: oznaczone nagłówkiem bg (worker nie liczy go jako aktywności
   * człowieka), błąd nie psuje tego, co już widać, a przerysowują się tylko widżety ze zmienionymi danymi.
   */
  async function load({ manual = false, quiet = false } = {}) {
    if (manual) K.setBusy(refreshBtn, true);
    lastLoadAt = Date.now();
    const seq = writeSeq;
    const keys = Object.keys(sources);
    const res = await Promise.allSettled(keys.map((k) => sources[k]({ bg: quiet })));
    if (manual) K.setBusy(refreshBtn, false);
    if (signal.aborted) return;
    // zapis w trakcie albo od startu odczytu: migawka list mogła być sprzed zapisu, więc ją odrzucamy
    const staleLists = writes > 0 || seq !== writeSeq;
    const changed = new Set();
    keys.forEach((k, i) => {
      const x = res[i];
      if (k === "lists" && staleLists) return;
      let sig;
      if (x.status === "fulfilled") {
        sig = sigOf(k, x.value);
        data[k] = x.value;
        delete errs[k];
        if (k === "health" && !quiet) changed.add("system"); // czas działania i opóźnienie odświeżamy przy świadomym odczycie
      } else {
        if (K.isAbort(x.reason) || (quiet && data[k] != null)) return;
        errs[k] = x.reason;
        sig = `err:${x.reason?.message}`;
      }
      if (sig !== sigs[k]) {
        sigs[k] = sig;
        for (const w of DEPENDS[k]) changed.add(w);
      }
    });
    if (changed.has("todo") || changed.has("kpi")) work = flattenWork(data.lists ?? []);
    paint(changed, { quiet });
    if (manual) K.toast(t("dash.refreshed"));
  }

  const retry = () => void load({ manual: true });
  const failed = (...keys) => keys.map((k) => errs[k]).find(Boolean);

  // -------------------------------------------------------------------------
  // Kafelki liczb
  // -------------------------------------------------------------------------

  function renderKpi() {
    const el = slots.kpi;
    el.setAttribute("aria-label", t("dash.w.kpi"));
    const s = data.stats;
    const act = data.activity ?? [];
    const sum = summarize(work.items);
    const week = act.slice(-7);
    const dash = "–";
    const tile = (label, value, sub, { href, goto, tone, text } = {}) => {
      const inner = [
        h("p", { class: `hx-stat__value${text ? " dash-tile__text" : ""}` }, value),
        h("p", { class: "hx-stat__label" }, label),
        sub ? h("p", { class: "app-stat__sub" }, sub) : null,
      ];
      const cls = `dash-tile hx-chamfer hx-chamfer--line${tone ? ` dash-tile--${tone}` : ""}`;
      if (goto) {
        const b = h("button", { class: cls, type: "button" }, inner);
        b.addEventListener("click", goto);
        return b;
      }
      return h("a", { class: cls, href }, inner);
    };
    const newest = (data.recent ?? [])[0];
    const lastMs = Math.max(Number(newest?.created_at) || 0, Number((data.sessions ?? [])[0]?.last_activity_at) || 0);
    const ok = data.health?.ok;
    el.replaceChildren(
      h(
        "div",
        { class: "dash-kpi" },
        tile(t("dash.kpi.open"), data.lists ? K.num(sum.open) : dash, data.lists ? t("dash.kpi.openSub", { doing: K.num(sum.by.doing), blocked: K.num(sum.by.blocked) }) : null, {
          goto: () => slots.todo.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }),
          tone: sum.by.blocked ? "warn" : null,
        }),
        tile(t("dash.kpi.notes"), s ? K.num(s.active) : dash, act.length ? t("dash.kpi.today", { n: act[act.length - 1].notes }) : null, { href: "#/strumien" }),
        tile(t("dash.kpi.sessions"), s ? K.num(s.sessions) : dash, act.length ? t("dash.kpi.week", { n: week.reduce((a, d) => a + d.sessions, 0) }) : null, { href: "#/sesje" }),
        tile(t("dash.kpi.projects"), s ? K.num(s.projects) : dash, data.lists ? t("dash.kpi.withOpen", { n: sum.openProjects }) : null, { href: "#/projekty" }),
        tile(t("dash.kpi.last"), lastMs ? K.fmtRel(lastMs) : dash, newest?.project ?? null, { href: "#/strumien", text: true }),
        tile(t("dash.kpi.worker"), data.health ? (ok ? t("dash.sys.ok") : t("dash.sys.problem")) : dash, s ? (data.health?.embedder?.device === "wyłączony" ? t("dash.kpi.vecOff") : s.missingVectors ? t("dash.kpi.vecQueue", { n: s.missingVectors }) : t("dash.kpi.vecOk")) : null, {
          href: "#/statystyki",
          tone: data.health && !ok ? "warn" : null,
          text: true,
        }),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Zbiorcze TODO (praca w toku, wszystkie projekty)
  // -------------------------------------------------------------------------

  const todo = {};

  function buildTodo() {
    const search = h("input", {
      class: "hx-input",
      id: "dash-todo-q",
      type: "search",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: t("dash.todo.search"),
      "aria-label": t("dash.todo.searchLabel"),
    });
    search.addEventListener("input", () => {
      query = search.value;
      renderTodo();
    });
    const projectSel = h("select", { class: "hx-select", id: "dash-todo-proj", "aria-label": t("dash.todo.projectLabel") });
    projectSel.addEventListener("change", () => {
      prefs.project = projectSel.value;
      save();
      renderTodo();
      renderProjects();
    });
    const chip = (label, onClick) => {
      const n = h("span", { class: "dash-chip__n" }, "0");
      const b = h("button", { class: "hx-tag hx-fill app-chip", type: "button", "aria-pressed": "false" }, h("span", null, label), n);
      b.addEventListener("click", onClick);
      return { b, n };
    };
    todo.statusChips = Object.entries(FILTERS).map(([key, labelKey]) => ({
      key,
      ...chip(t(labelKey), () => {
        prefs.status = key;
        save();
        renderTodo();
      }),
    }));
    todo.stale = chip(t("dash.f.stale"), () => {
      prefs.stale = !prefs.stale;
      save();
      renderTodo();
    });
    todo.stale.b.title = t("dash.f.staleHint");
    todo.groupChips = Object.entries(GROUPS).map(([key, labelKey]) => ({
      key,
      b: h("button", { class: "hx-tag hx-fill app-chip", type: "button", "aria-pressed": "false" }, t(labelKey)),
    }));
    for (const g of todo.groupChips)
      g.b.addEventListener("click", () => {
        prefs.group = g.key;
        save();
        renderTodo();
      });

    const copyBtn = K.btn(t("dash.todo.copy"), { variant: "ghost", size: "sm" });
    copyBtn.addEventListener("click", async () => {
      const md = toMarkdown(todo.visible ?? [], { doing: statusLabel("doing"), blocked: statusLabel("blocked") });
      if (!md) {
        K.toast(t("dash.todo.copyNone"));
        return;
      }
      K.toast((await K.copyText(md)) ? t("dash.todo.copied", { n: (todo.visible ?? []).length }) : t("dash.todo.copyFail"));
    });
    const addBtn = K.btn(t("dash.todo.add"), { variant: "secondary", size: "sm" });
    addBtn.setAttribute("aria-expanded", "false");
    addBtn.setAttribute("aria-controls", "dash-add");
    addBtn.addEventListener("click", () => {
      const open = todo.form.hidden;
      todo.form.hidden = !open;
      addBtn.setAttribute("aria-expanded", String(open));
      if (open) $("#dash-add-task")?.focus();
    });
    buildAddForm();

    todo.sub = h("p", { class: "hx-help dash-sub" });
    todo.results = h("div", { class: "dash-results" });
    todo.search = search;
    todo.projectSel = projectSel;
    const id = uid("dash-todo");
    slots.todo.setAttribute("aria-labelledby", id);
    slots.todo.replaceChildren(
      h(
        "div",
        { class: "app-block hx-chamfer hx-chamfer--line dash-todo" },
        h(
          "div",
          { class: "app-block__head" },
          h("div", null, h("h2", { class: "app-block__title", id }, t("dash.todo.title")), todo.sub),
          h("div", { class: "hx-cluster" }, copyBtn, addBtn),
        ),
        todo.form,
        h(
          "div",
          { class: "dash-filters" },
          h("div", { class: "hx-field app-field" }, h("label", { class: "hx-label", for: "dash-todo-q" }, t("dash.todo.searchLabel")), search),
          h("div", { class: "hx-field app-field" }, h("label", { class: "hx-label", for: "dash-todo-proj" }, t("dash.todo.projectLabel")), projectSel),
        ),
        h(
          "div",
          { class: "dash-chips" },
          h("div", { class: "app-chips", role: "group", "aria-label": t("dash.todo.statusLabel") }, todo.statusChips.map((c) => c.b), todo.stale.b),
          h("div", { class: "app-chips", role: "group", "aria-label": t("dash.todo.groupLabel") }, todo.groupChips.map((g) => g.b)),
        ),
        todo.results,
      ),
    );
  }

  /** Zmienione ustawienia (np. reset) przenosimy na kontrolki TODO. */
  function syncTodoControls() {
    for (const c of todo.statusChips) c.b.setAttribute("aria-pressed", String(prefs.status === c.key));
    todo.stale.b.setAttribute("aria-pressed", String(prefs.stale));
    for (const g of todo.groupChips) g.b.setAttribute("aria-pressed", String(prefs.group === g.key));
  }

  function syncProjectOptions() {
    const counts = new Map();
    for (const it of work.items) {
      const k = fold(it.project);
      const c = counts.get(k) ?? { name: it.project, open: 0 };
      if (isOpen(it)) c.open++;
      counts.set(k, c);
    }
    const rows = [...counts.values()].sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
    // wybrany projekt bez żadnych pozycji (np. po usunięciu): zostaje na liście, żeby wybór był widoczny
    if (prefs.project && !rows.some((x) => same(x.name, prefs.project))) rows.push({ name: prefs.project, open: 0 });
    const sig = JSON.stringify(rows);
    if (todo.projectSig !== sig) {
      todo.projectSig = sig;
      todo.projectSel.replaceChildren(
        h("option", { value: "" }, t("dash.todo.allProjects")),
        rows.map((x) => h("option", { value: x.name }, `${x.name} (${K.num(x.open)})`)),
      );
    }
    todo.projectSel.value = rows.find((x) => same(x.name, prefs.project))?.name ?? "";
    todo.rows = rows;
  }

  function renderTodo() {
    if (slots.todo.hidden) return;
    const now = Date.now();
    syncProjectOptions();
    syncTodoControls();
    todo.results.setAttribute("aria-busy", "false");

    if (!data.lists) {
      todo.sub.textContent = "";
      todo.results.replaceChildren(errs.lists ? K.errorAlert(errs.lists, retry) : K.loadingText(t("dash.todo.loading")));
      return;
    }
    const scoped = prefs.project ? work.items.filter((it) => same(it.project, prefs.project)) : work.items;
    const sum = summarize(scoped, now);
    const counts = { all: sum.open, blocked: sum.by.blocked, doing: sum.by.doing, todo: sum.by.todo, done: sum.completed };
    for (const c of todo.statusChips) c.n.textContent = K.num(counts[c.key] ?? 0);
    todo.stale.n.textContent = K.num(sum.stale);
    todo.sub.textContent = t("dash.todo.sub", { open: K.num(sum.open), projects: K.num(sum.openProjects) });

    const visible = sortItems(filterItems(scoped, { status: prefs.status, stale: prefs.stale, q: query }, now));
    todo.visible = visible;
    if (!scoped.length) {
      todo.results.replaceChildren(K.emptyState(t("dash.todo.empty.title"), t("dash.todo.empty.text")));
      return;
    }
    if (!visible.length) {
      const clear = K.btn(t("dash.todo.clear"), { variant: "secondary", size: "sm" });
      clear.addEventListener("click", () => {
        prefs.status = "all";
        prefs.stale = false;
        query = "";
        todo.search.value = "";
        save();
        renderTodo();
      });
      todo.results.replaceChildren(K.emptyState(t("dash.todo.none.title"), t("dash.todo.none.text"), clear));
      return;
    }
    if (prefs.group === "project") todo.results.replaceChildren(...groupByProject(visible).map((g) => projectCard(g, scoped)));
    else if (prefs.group === "status") todo.results.replaceChildren(...groupByStatus(visible).map(statusCard));
    else todo.results.replaceChildren(taskList(visible, "flat", { showProject: true, showList: true }));
  }

  /** Lista pozycji z limitem CAP i przyciskiem „Pokaż więcej” (stan rozwinięcia tylko do zamknięcia widoku). */
  function taskList(items, key, opts) {
    const open = expanded.has(key);
    const shown = open ? items : items.slice(0, CAP);
    const ul = h("ul", { class: "dash-tasks" }, shown.map((it) => taskRow(it, opts)));
    if (items.length <= CAP) return ul;
    const more = K.btn(open ? t("dash.todo.less") : t("dash.todo.more", { n: items.length - CAP }), { variant: "ghost", size: "sm" });
    more.addEventListener("click", () => {
      if (open) expanded.delete(key);
      else expanded.add(key);
      renderTodo();
    });
    return h("div", null, ul, more);
  }

  function projectCard(g, scoped) {
    const all = scoped.filter((it) => same(it.project, g.project));
    const done = all.filter((it) => !isOpen(it)).length;
    const sum = summarize(all);
    const det = h("details", { class: "dash-group hx-chamfer hx-chamfer--line", open: !prefs.collapsed.includes(g.key) });
    det.addEventListener("toggle", () => {
      const c = new Set(prefs.collapsed);
      if (det.open) c.delete(g.key);
      else c.add(g.key);
      prefs.collapsed = [...c].slice(0, 100);
      save();
    });
    const bar = K.setV(h("span", { class: "app-rel__fill" }), all.length ? done / all.length : 0);
    const open = h("a", { class: "hx-link dash-group__link", href: "#/praca" }, t("dash.todo.openLists"));
    open.addEventListener("click", () => K.setProject(g.project));
    det.append(
      h(
        "summary",
        { class: "dash-group__head" },
        h("span", { class: "dash-group__name" }, g.project),
        h(
          "span",
          { class: "dash-group__meta" },
          sum.by.blocked ? K.toneBadge(t("dash.todo.nBlocked", { n: sum.by.blocked }), "warning") : null,
          sum.by.doing ? K.toneBadge(t("dash.todo.nDoing", { n: sum.by.doing }), "info") : null,
          h("span", null, t("dash.todo.progress", { done: K.num(done), total: K.num(all.length) })),
        ),
        h("span", { class: "app-rel dash-group__bar", "aria-hidden": "true" }, h("span", { class: "app-rel__bar" }, bar)),
      ),
      h(
        "div",
        { class: "dash-group__body" },
        groupByList(g.items).map((l) => listBlock(l, g)),
        h("p", { class: "dash-group__foot" }, open),
      ),
    );
    return det;
  }

  function listBlock(l, g) {
    const ctx = work.contexts.find((c) => same(c.project, g.project) && c.list === l.name);
    const ctxEl = ctx
      ? h(
          "details",
          { class: "dash-ctx" },
          h("summary", null, t("dash.todo.context", { n: Object.keys(ctx.state).length })),
          K.kv(Object.entries(ctx.state).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])),
        )
      : null;
    return h(
      "section",
      { class: "dash-list" },
      h("h3", { class: "dash-list__name" }, l.name, l.items.some((it) => it.listClosed) ? K.toneBadge(t("dash.todo.listClosed"), "") : null),
      ctxEl,
      taskList(l.items, `${g.key}/${l.name}`, { showProject: false, showList: false }),
    );
  }

  function statusCard(g) {
    return h(
      "section",
      { class: "dash-group dash-group--flat hx-chamfer hx-chamfer--line" },
      h("h3", { class: "dash-list__name" }, statusLabel(g.cat), h("span", { class: "dash-group__count" }, K.num(g.items.length))),
      taskList(g.items, `status/${g.cat}`, { showProject: true, showList: true }),
    );
  }

  function taskRow(it, { showProject, showList }) {
    const sel = h("select", {
      class: "hx-select dash-status",
      "data-cat": it.cat,
      "data-key": rowKey(it),
      "aria-label": t("dash.task.statusOf", { task: it.task }),
    });
    for (const s of Object.keys(STATUS_LABEL)) sel.append(h("option", { value: s }, statusLabel(s)));
    sel.value = it.own;
    sel.addEventListener("change", () => queueStatus(it, sel.value));
    const fields = fieldsText(it.fields);
    return h(
      "li",
      { class: "dash-task", "data-cat": it.cat },
      h("div", { class: "dash-task__status" }, sel),
      h(
        "div",
        { class: "dash-task__main" },
        h("p", { class: "dash-task__text" }, it.task),
        fields ? h("p", { class: "dash-task__fields" }, fields) : null,
        h(
          "p",
          { class: "dash-task__meta" },
          showProject ? h("span", { class: "note__project" }, it.project) : null,
          showList ? h("span", { class: "app-mono" }, it.list) : null,
          it.listClosed ? K.toneBadge(t("dash.todo.listClosed"), "") : null,
          isStale(it) ? K.toneBadge(t("dash.todo.stale"), "warning") : null,
          K.timeEl(it.updatedAt),
        ),
      ),
    );
  }

  const rowKey = (it) => `${fold(it.project)}\n${it.list}\n${it.task}`;
  const findList = (project, name) => (data.lists ?? []).find((x) => same(x.project, project) && x.name === name);
  const postWork = (project, list, fields) => K.api("/api/work-state", { method: "POST", body: { project, list, fields } });

  /** Przerysowuje TODO i oddaje fokus selektowi tej samej pozycji (przerysowanie wymienia cały wiersz). */
  function repaintTodo() {
    const a = document.activeElement;
    const key = a instanceof HTMLElement && slots.todo.contains(a) ? a.dataset.key : null;
    renderTodo();
    todo.syncAdd?.();
    if (!key) return;
    for (const sel of slots.todo.querySelectorAll("select[data-key]")) {
      if (sel.dataset.key === key) {
        sel.focus({ preventScroll: true });
        break;
      }
    }
  }

  /** Zapis statusu z opóźnieniem: kolejne zmiany tej samej pozycji (strzałki na liście) zlewają się w jeden wpis. */
  function queueStatus(it, value) {
    const key = rowKey(it);
    clearTimeout(pending.get(key)?.timer);
    const run = () => {
      pending.delete(key);
      void changeStatus(it, value);
    };
    pending.set(key, { timer: setTimeout(run, STATUS_DEBOUNCE_MS), run });
  }

  /**
   * Zmiana statusu to zwykły wpis w dzienniku listy (POST /api/work-state): najnowszy wygrywa, więc łatwo ją cofnąć.
   * Otwarcie pozycji na zamkniętej liście otwiera też listę (wpis listy bez task, status inny niż done).
   */
  async function changeStatus(it, value) {
    writes++;
    let reopened = false;
    try {
      const list = findList(it.project, it.list);
      if (list?.closed && OPEN_CATS.includes(statusCat(value))) {
        await postWork(it.project, it.list, { status: "open" });
        list.closed = false;
        list.state = { ...list.state, status: "open" };
        reopened = true;
      }
      await postWork(it.project, it.list, { task: it.task, status: value });
      const item = list?.items.find((x) => x.task === it.task);
      if (item) {
        item.status = value;
        item.updatedAt = Date.now();
        list.updatedAt = item.updatedAt;
      }
      work = flattenWork(data.lists ?? []);
      const msg = t(reopened ? "dash.task.savedReopened" : "dash.task.saved", { status: statusLabel(value), list: it.list });
      K.toast(msg);
      K.announce(msg);
    } catch (e) {
      // 401: ekran wejścia już jest (api przerywa), bez komunikatu pod nim
      if (!K.isAbort(e)) K.toast(e.message);
    } finally {
      writes--;
      writeSeq++;
    }
    repaintTodo();
    renderKpi();
    renderProjects();
  }

  const $ = (sel) => root.querySelector(sel);

  function buildAddForm() {
    const projSel = h("select", { class: "hx-select", id: "dash-add-proj", required: true });
    const listIn = h("input", { class: "hx-input", id: "dash-add-list", list: "dash-add-lists", maxlength: "80", required: true, autocomplete: "off" });
    const lists = h("datalist", { id: "dash-add-lists" });
    const taskIn = h("input", { class: "hx-input", id: "dash-add-task", maxlength: "400", required: true, autocomplete: "off", placeholder: t("dash.add.taskPh") });
    const submit = K.btn(t("dash.add.submit"), { type: "submit", spinner: true });
    const field = (idFor, label, ...c) => h("div", { class: "hx-field app-field" }, h("label", { class: "hx-label", for: idFor }, label), ...c);
    const form = h(
      "form",
      { class: "dash-add hx-chamfer hx-chamfer--line", id: "dash-add", hidden: true },
      field("dash-add-proj", t("dash.add.project"), projSel),
      field("dash-add-list", t("dash.add.list"), listIn, lists),
      field("dash-add-task", t("dash.add.task"), taskIn),
      submit,
    );
    // nazwa listy wpisana przez człowieka nie jest nadpisywana przy odświeżeniu danych w tle
    let listDirty = false;
    listIn.addEventListener("input", () => {
      listDirty = true;
    });
    const fillLists = () => {
      const names = [...new Set((data.lists ?? []).filter((l) => same(l.project, projSel.value)).map((l) => l.name))];
      const open = (data.lists ?? []).filter((l) => same(l.project, projSel.value) && !l.closed).sort((a, b) => b.updatedAt - a.updatedAt);
      lists.replaceChildren(...names.map((n) => h("option", { value: n })));
      if (!listDirty || !listIn.value) listIn.value = open[0]?.name ?? names[0] ?? "TODO";
    };
    projSel.addEventListener("change", () => {
      listDirty = false;
      fillLists();
    });
    todo.syncAdd = () => {
      const names = new Map();
      for (const x of [...(todo.rows ?? []).map((p) => p.name), ...(data.projects ?? []).map((p) => p.project)]) if (!names.has(fold(x))) names.set(fold(x), x);
      const prev = projSel.value;
      const sig = [...names.values()].join("\n");
      if (todo.addSig !== sig) {
        todo.addSig = sig;
        projSel.replaceChildren(...[...names.values()].map((n) => h("option", { value: n }, n)));
      }
      projSel.value = [...names.values()].find((n) => same(n, prev)) ?? [...names.values()].find((n) => same(n, prefs.project)) ?? [...names.values()][0] ?? "";
      fillLists();
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const task = taskIn.value.trim();
      const list = listIn.value.trim();
      if (!task || !list || !projSel.value || K.isBusy(submit)) return;
      K.setBusy(submit, true);
      writes++;
      try {
        // dodanie zadania do zamkniętej listy otwiera ją, inaczej zadanie od razu wpadłoby do zakończonych
        const reopen = findList(projSel.value, list)?.closed;
        if (reopen) await postWork(projSel.value, list, { status: "open" });
        await postWork(projSel.value, list, { task, status: "todo" });
        taskIn.value = "";
        const msg = t(reopen ? "dash.add.doneReopened" : "dash.add.done", { list });
        K.toast(msg);
        K.announce(msg);
        data.lists = await K.api("/api/work-state/all?closed=1", { signal });
        sigs.lists = sigOf("lists", data.lists);
        work = flattenWork(data.lists);
        repaintTodo();
        renderKpi();
        renderProjects();
        taskIn.focus();
      } catch (err) {
        if (!K.isAbort(err)) K.toast(err.message);
      } finally {
        writes--;
        writeSeq++;
        K.setBusy(submit, false);
      }
    });
    todo.form = form;
  }

  // -------------------------------------------------------------------------
  // Aktywność
  // -------------------------------------------------------------------------

  const act = {};

  function buildActivity() {
    act.chips = DAYS.map((d) => {
      const b = h("button", { class: "hx-tag hx-fill app-chip", type: "button", "aria-pressed": "false" }, t("dash.act.days", { n: d }));
      b.addEventListener("click", () => {
        prefs.days = d;
        save();
        renderActivity();
      });
      return { d, b };
    });
    act.host = h("div");
    act.sum = h("p", { class: "hx-help" });
    const id = uid("dash-act");
    slots.activity.setAttribute("aria-labelledby", id);
    slots.activity.replaceChildren(
      h(
        "div",
        { class: "app-block hx-chamfer hx-chamfer--line" },
        h("div", { class: "app-block__head" }, h("h2", { class: "app-block__title", id }, t("dash.act.title")), h("div", { class: "app-chips", role: "group", "aria-label": t("dash.act.range") }, act.chips.map((c) => c.b))),
        act.host,
        act.sum,
      ),
    );
  }

  function renderActivity() {
    if (slots.activity.hidden) return;
    for (const c of act.chips) c.b.setAttribute("aria-pressed", String(c.d === prefs.days));
    if (!data.activity) {
      act.sum.textContent = "";
      act.host.replaceChildren(errs.activity ? K.errorAlert(errs.activity, retry) : K.loadingText(t("dash.act.loading")));
      return;
    }
    const rows = data.activity.slice(-prefs.days);
    const max = Math.max(1, ...rows.map((d) => d.notes));
    const wd = new Intl.DateTimeFormat(K.locale(), { weekday: "short" });
    const full = new Intl.DateTimeFormat(K.locale(), { weekday: "long", day: "numeric", month: "long" });
    const today = rows[rows.length - 1]?.day;
    const bars = h(
      "ol",
      { class: "dash-bars", "data-n": String(rows.length), "aria-label": t("dash.act.chart") },
      rows.map((d) => {
        const at = new Date(`${d.day}T12:00:00`);
        const label = rows.length <= 7 ? wd.format(at) : String(at.getDate());
        const text = t("dash.act.day", { date: full.format(at), notes: t("dash.n.notes", { n: d.notes }), sessions: t("dash.n.sessions", { n: d.sessions }) });
        return h(
          "li",
          { class: `dash-bar${d.day === today ? " dash-bar--today" : ""}`, title: text },
          h("span", { class: "dash-bar__n", "aria-hidden": "true" }, d.notes ? K.num(d.notes) : ""),
          h("span", { class: "dash-bar__col", "aria-hidden": "true" }, K.setV(h("span", { class: "dash-bar__fill" }), d.notes / max)),
          h("span", { class: "dash-bar__lbl", "aria-hidden": "true" }, label),
          h("span", { class: "hx-sr-only" }, text),
        );
      }),
    );
    act.host.replaceChildren(bars);
    const notes = rows.reduce((a, d) => a + d.notes, 0);
    const sessions = rows.reduce((a, d) => a + d.sessions, 0);
    act.sum.textContent = t("dash.act.summary", { notes: t("dash.n.notes", { n: notes }), sessions: t("dash.n.sessions", { n: sessions }), days: K.num(rows.length) });
  }

  // -------------------------------------------------------------------------
  // Projekty, ostatnie notatki, sesje, system
  // -------------------------------------------------------------------------

  function renderProjects() {
    const el = slots.projects;
    if (el.hidden) return;
    const err = failed("projects");
    if (!data.projects) {
      el.replaceChildren(h("div", { class: "app-block hx-chamfer hx-chamfer--line" }, ...widgetBlock("projects", "dash.w.projects", err ? K.errorAlert(err, retry) : K.loadingText(t("dash.proj.loading")))));
      return;
    }
    const open = new Map();
    for (const it of work.items) if (isOpen(it)) open.set(fold(it.project), (open.get(fold(it.project)) ?? 0) + 1);
    const total = data.projects.reduce((a, p) => a + (Number(p.observations) || 0), 0) || 1;
    const rows = data.projects.slice(0, 6);
    const list = rows.length
      ? h(
          "ol",
          { class: "dash-proj" },
          rows.map((p) => {
            const on = same(p.project, prefs.project);
            const pick = h("button", { class: "note__link dash-proj__pick", type: "button", "aria-pressed": String(on), title: t("dash.proj.filterHint") }, p.project);
            pick.addEventListener("click", () => {
              prefs.project = on ? "" : p.project;
              save();
              renderTodo();
              renderProjects();
              if (!on) slots.todo.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
            });
            const notes = h("a", { class: "hx-link", href: "#/strumien" }, t("dash.proj.notes"));
            notes.addEventListener("click", () => K.setProject(p.project));
            const nOpen = open.get(fold(p.project)) ?? 0;
            return h(
              "li",
              { class: "dash-proj__item" },
              h("div", { class: "dash-proj__top" }, pick, nOpen ? K.toneBadge(t("dash.proj.open", { n: nOpen }), "info") : null),
              h(
                "p",
                { class: "note__meta" },
                h("span", null, t("dash.n.notes", { n: Number(p.observations) || 0 })),
                p.last_at ? K.timeEl(p.last_at) : null,
                h("span", { class: "app-rel", "aria-hidden": "true" }, h("span", { class: "app-rel__bar" }, K.setV(h("span", { class: "app-rel__fill" }), (Number(p.observations) || 0) / total))),
                notes,
              ),
            );
          }),
        )
      : K.emptyState(t("dash.proj.empty"), null);
    el.replaceChildren(
      h(
        "div",
        { class: "app-block hx-chamfer hx-chamfer--line" },
        ...widgetBlock("projects", "dash.w.projects", list, h("p", { class: "dash-more" }, h("a", { class: "hx-link", href: "#/projekty" }, t("dash.proj.all")))),
      ),
    );
  }

  function renderRecent() {
    const el = slots.recent;
    if (el.hidden) return;
    const err = failed("recent");
    let body;
    if (!data.recent) body = err ? K.errorAlert(err, retry) : K.loadingText(t("dash.recent.loading"));
    else if (!data.recent.length) body = K.emptyState(t("dash.recent.empty.title"), t("dash.recent.empty.text"));
    else body = h("ol", { class: "app-list dash-notes", "aria-label": t("dash.w.recent") }, data.recent.map((o) => K.noteRow(o, { level: 3 })));
    el.replaceChildren(
      h("div", { class: "app-block hx-chamfer hx-chamfer--line" }, ...widgetBlock("recent", "dash.w.recent", body, h("p", { class: "dash-more" }, h("a", { class: "hx-link", href: "#/strumien" }, t("dash.recent.all"))))),
    );
  }

  function renderSessions() {
    const el = slots.sessions;
    if (el.hidden) return;
    const err = failed("sessions");
    let body;
    if (!data.sessions) body = err ? K.errorAlert(err, retry) : K.loadingText(t("dash.sess.loading"));
    else if (!data.sessions.length) body = K.emptyState(t("dash.sess.empty"), null);
    else body = h("ol", { class: "app-list dash-notes", "aria-label": t("dash.w.sessions") }, data.sessions.map((s) => K.sessionRow(s, 3)));
    el.replaceChildren(
      h("div", { class: "app-block hx-chamfer hx-chamfer--line" }, ...widgetBlock("sessions", "dash.w.sessions", body, h("p", { class: "dash-more" }, h("a", { class: "hx-link", href: "#/sesje" }, t("dash.sess.all"))))),
    );
  }

  function renderSystem() {
    const el = slots.system;
    if (el.hidden) return;
    const hl = data.health;
    const s = data.stats;
    const err = failed("health", "stats");
    let body;
    if (!hl && !s) body = err ? K.errorAlert(err, retry) : K.loadingText(t("dash.sys.loading"));
    else {
      const emb = hl?.embedder ?? {};
      const vecOff = emb.device === "wyłączony";
      body = K.kv([
        [t("dash.sys.state"), hl ? (hl.ok ? K.toneBadge(t("dash.sys.ok"), "success") : K.toneBadge(t("dash.sys.problem"), "warning")) : null],
        [t("dash.sys.version"), hl?.version],
        [t("dash.sys.uptime"), hl ? K.fmtDur((hl.uptimeS ?? 0) * 1000) : null],
        [t("dash.sys.vectors"), s ? (vecOff ? t("dash.sys.vecOff") : s.missingVectors ? K.toneBadge(t("dash.sys.vecQueue", { n: s.missingVectors }), "warning") : K.toneBadge(t("dash.sys.vecOk"), "success")) : null],
        [t("dash.sys.jobs"), s ? K.num(s.pendingJobs) : null],
        [t("dash.sys.failed"), s ? (s.failedJobs ? K.toneBadge(K.num(s.failedJobs), "error") : "0") : null],
        [t("dash.sys.lag"), hl?.eventLoopLagMs == null ? null : `${K.num(hl.eventLoopLagMs)} ms, max ${K.num(hl.eventLoopLagMaxMs)} ms`],
        [t("dash.sys.cost"), t("dash.sys.costValue")],
      ]);
    }
    el.replaceChildren(
      h("div", { class: "app-block hx-chamfer hx-chamfer--line" }, ...widgetBlock("system", "dash.w.system", body, h("p", { class: "dash-more" }, h("a", { class: "hx-link", href: "#/statystyki" }, t("dash.sys.all"))))),
    );
  }

  // -------------------------------------------------------------------------
  // Składanie widoku
  // -------------------------------------------------------------------------

  const RENDER = {
    kpi: () => renderKpi(),
    todo: () => {
      renderTodo();
      todo.syncAdd?.();
    },
    activity: () => renderActivity(),
    projects: () => renderProjects(),
    recent: () => renderRecent(),
    sessions: () => renderSessions(),
    system: () => renderSystem(),
  };
  const holdsFocus = (name) => {
    const a = document.activeElement;
    return a instanceof HTMLElement && a !== document.body && slots[name].contains(a);
  };

  /**
   * Rysuje widżety. W odświeżeniu w tle widżet, w którym jest fokus (wpisywany tekst, rozwinięty kontekst, wybrany
   * wiersz), czeka z przerysowaniem, aż fokus z niego wyjdzie; zmiany wywołane przez człowieka rysujemy od razu.
   */
  function paint(names, { quiet = false } = {}) {
    for (const w of names) {
      if (quiet && holdsFocus(w)) dirty.add(w);
      else {
        dirty.delete(w);
        RENDER[w]();
      }
    }
  }
  function flushDirty() {
    for (const w of [...dirty]) {
      if (holdsFocus(w)) continue;
      dirty.delete(w);
      RENDER[w]();
    }
  }
  root.addEventListener("focusout", () => setTimeout(flushDirty, 0));

  buildCustom();
  buildTodo();
  buildActivity();
  applyVisibility();
  root.append(
    K.viewHead(t("dash.kicker"), t("dash.title"), t("dash.lead")),
    h("div", { class: "dash-top" }, searchForm, h("div", { class: "hx-cluster" }, refreshBtn, customizeBtn)),
    customPanel,
    h("div", { class: "dash-stack" }, slots.kpi, slots.todo, h("div", { class: "dash-grid" }, slots.activity, slots.projects, slots.system, slots.recent, slots.sessions)),
  );
  paint(WIDGETS);

  // nowa notatka z SSE ląduje na górze listy ostatnich (bez pobierania), a licznik w kafelkach odświeży najbliższy odczyt
  K.route.live = (o) => {
    if (!data.recent || (o.status && o.status !== "active")) return false;
    if (data.recent.some((x) => x.id === o.id)) return true;
    data.recent = [o, ...data.recent].slice(0, 6);
    sigs.recent = sigOf("recent", data.recent);
    paint(["recent", "kpi"], { quiet: true });
    return true;
  };
  K.route.refresh = () => load({ quiet: true });

  // odświeżanie w tle tylko dla okna, z którego człowiek korzysta (widoczne i z fokusem); zostawiona karta na drugim
  // monitorze nie pyta workera, a samo zapytanie i tak idzie z nagłówkiem bg
  const tick = () => {
    if (!document.hidden && document.hasFocus()) void load({ quiet: true });
  };
  const onBack = () => {
    if (Date.now() - lastLoadAt > 15_000) tick();
  };
  timer = setInterval(tick, REFRESH_MS);
  document.addEventListener("visibilitychange", onBack);
  window.addEventListener("focus", onBack);
  K.route.cleanup = () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onBack);
    window.removeEventListener("focus", onBack);
    // zmiana statusu czekająca na debounce nie ginie przy zmianie widoku
    for (const p of [...pending.values()]) {
      clearTimeout(p.timer);
      p.run();
    }
  };

  void load();
}
