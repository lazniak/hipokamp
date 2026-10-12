// hipokamp: model danych Dashboardu (zbiorcze TODO). Czysty moduł bez DOM, testowany osobno.
// Wejście to listy pracy z /api/work-state/all: [{ project, name, closed, state, items:[{task,status,fields,updatedAt}], updatedAt }].

/** Klucz projektu jak COLLATE NOCASE w SQLite: wielkość liter zwija się tylko w ASCII (Ż i ż to różne projekty). */
export const fold = (s) => String(s ?? "").replace(/[A-Z]/g, (c) => c.toLowerCase());

export const STATUS_ORDER = ["blocked", "doing", "todo", "done", "dropped"];
export const OPEN_CATS = ["blocked", "doing", "todo"];
export const STALE_MS = 14 * 86_400_000;

const DOING = new Set(["doing", "in_progress", "in-progress", "wip", "started", "working"]);
const DONE = new Set(["done", "completed", "complete", "closed", "resolved"]);
const DROPPED = new Set(["dropped", "cancelled", "canceled", "abandoned", "wontfix"]);
const BLOCKED = new Set(["blocked", "waiting", "stuck"]);

/** Kategoria statusu z dziennika: agenci zapisują różne słowa (doing, in_progress, wip…), reszta to „do zrobienia”. */
export function statusCat(status) {
  const s = String(status ?? "").trim().toLowerCase();
  if (DONE.has(s)) return "done";
  if (DROPPED.has(s)) return "dropped";
  if (BLOCKED.has(s)) return "blocked";
  if (DOING.has(s)) return "doing";
  return "todo";
}

/** Tekst z dodatkowych pól pozycji (bez task i status), np. „opis: …; termin: …”. */
export function fieldsText(fields) {
  return Object.entries(fields ?? {})
    .filter(([k]) => k !== "status" && k !== "task")
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("; ");
}

/**
 * Spłaszcza listy do pozycji i kontekstów. Pozycja z zamkniętej listy liczy się jako zakończona (cat = done),
 * nawet gdy jej własny status jest otwarty: zamknięcie listy kończy całą jej pracę.
 */
export function flattenWork(lists) {
  const items = [];
  const contexts = [];
  for (const l of lists ?? []) {
    for (const it of l.items ?? []) {
      const own = statusCat(it.status);
      items.push({
        project: l.project,
        list: l.name,
        listClosed: !!l.closed,
        task: it.task,
        status: it.status,
        own,
        cat: l.closed && OPEN_CATS.includes(own) ? "done" : own,
        fields: it.fields ?? {},
        updatedAt: it.updatedAt ?? l.updatedAt ?? 0,
      });
    }
    const ctx = Object.entries(l.state ?? {}).filter(([k]) => k !== "status");
    if (ctx.length) contexts.push({ project: l.project, list: l.name, closed: !!l.closed, state: Object.fromEntries(ctx), updatedAt: l.updatedAt ?? 0 });
  }
  return { items, contexts };
}

export const isOpen = (it) => OPEN_CATS.includes(it.cat);
export const isStale = (it, now = Date.now()) => isOpen(it) && now - it.updatedAt > STALE_MS;

/** Liczby do pasków i kafelków: per kategoria, otwarte razem, zalegające (14+ dni bez ruchu), projekty z otwartą pracą. */
export function summarize(items, now = Date.now()) {
  const by = { blocked: 0, doing: 0, todo: 0, done: 0, dropped: 0 };
  let stale = 0;
  const openProjects = new Set();
  for (const it of items) {
    by[it.cat]++;
    if (isOpen(it)) openProjects.add(fold(it.project));
    if (isStale(it, now)) stale++;
  }
  return { by, open: by.blocked + by.doing + by.todo, completed: by.done + by.dropped, stale, openProjects: openProjects.size };
}

/**
 * Filtr widoku TODO. status: "all" (tylko otwarte) | blocked | doing | todo | "done" (zakończone i porzucone).
 * stale: tylko otwarte nieruszane 14+ dni. q: fragment w zadaniu, projekcie, liście albo polach (bez wielkości liter).
 */
export function filterItems(items, { status = "all", stale = false, q = "", project = "" } = {}, now = Date.now()) {
  const needle = q.trim().toLowerCase();
  const proj = fold(project);
  return items.filter((it) => {
    if (proj && fold(it.project) !== proj) return false;
    if (status === "all" ? !isOpen(it) : status === "done" ? isOpen(it) : it.cat !== status) return false;
    if (stale && !isStale(it, now)) return false;
    if (!needle) return true;
    return `${it.task}\n${it.project}\n${it.list}\n${fieldsText(it.fields)}`.toLowerCase().includes(needle);
  });
}

/** Najpierw zablokowane, w toku, do zrobienia, potem zakończone; wewnątrz od ostatnio ruszanych. */
export function sortItems(items) {
  return [...items].sort(
    (a, b) => STATUS_ORDER.indexOf(a.cat) - STATUS_ORDER.indexOf(b.cat) || b.updatedAt - a.updatedAt || a.task.localeCompare(b.task),
  );
}

/** Grupy po projekcie (najświeższy ruch pierwszy, bez względu na wielkość liter w nazwie). */
export function groupByProject(items) {
  const map = new Map();
  for (const it of items) {
    const key = fold(it.project);
    let g = map.get(key);
    if (!g) map.set(key, (g = { key, project: it.project, items: [], updatedAt: 0 }));
    g.items.push(it);
    g.updatedAt = Math.max(g.updatedAt, it.updatedAt);
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.project.localeCompare(b.project));
}

/** Listy wewnątrz projektu: ta z najświeższą zmianą pierwsza. */
export function groupByList(items) {
  const map = new Map();
  for (const it of items) {
    let g = map.get(it.list);
    if (!g) map.set(it.list, (g = { name: it.list, items: [], updatedAt: 0 }));
    g.items.push(it);
    g.updatedAt = Math.max(g.updatedAt, it.updatedAt);
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

/** Grupy po statusie w stałej kolejności; puste pomijamy. */
export function groupByStatus(items) {
  return STATUS_ORDER.map((cat) => ({ key: cat, cat, items: items.filter((it) => it.cat === cat) })).filter((g) => g.items.length);
}

/** Lista kontrolna Markdown do schowka: projekt, lista, pozycje; w toku i zablokowane z dopiskiem. */
export function toMarkdown(items, labels = {}) {
  const lines = [];
  for (const g of groupByProject(sortItems(items))) {
    lines.push(`## ${g.project}`, "");
    for (const l of groupByList(g.items)) {
      lines.push(`### ${l.name}`, "");
      for (const it of sortItems(l.items)) {
        const mark = isOpen(it) ? "[ ]" : "[x]";
        const note = it.cat === "doing" || it.cat === "blocked" ? ` (${labels[it.cat] ?? it.cat})` : "";
        lines.push(`- ${mark} ${it.task.replace(/\s+/g, " ").trim()}${note}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n").trim();
}
