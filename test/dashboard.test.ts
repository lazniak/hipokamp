// Model Dashboardu (zbiorcze TODO): kategorie statusów, spłaszczanie list, filtry, sortowanie, grupy, Markdown.
import { describe, expect, test } from "bun:test";

const load = (path: string): Promise<any> => import(path);
const m = await load("../viewer/dashboard-model.js");

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const DAY = 86_400_000;
const lists = [
  {
    project: "hipokamp",
    name: "wdrożenie",
    closed: false,
    state: { objective: "wdrożyć", status: "doing" },
    updatedAt: NOW - DAY,
    items: [
      { task: "Scalić PR", status: "todo", fields: { opis: "squash" }, updatedAt: NOW - 20 * DAY },
      { task: "Log przestoju", status: "in_progress", fields: {}, updatedAt: NOW - DAY },
      { task: "Hasło", status: "blocked", fields: {}, updatedAt: NOW - 2 * DAY },
    ],
  },
  {
    project: "Alfa",
    name: "stare",
    closed: true,
    state: {},
    updatedAt: NOW - 30 * DAY,
    items: [
      { task: "Zrobione", status: "done", fields: {}, updatedAt: NOW - 30 * DAY },
      { task: "Zapomniane w zamkniętej", status: "todo", fields: {}, updatedAt: NOW - 40 * DAY },
    ],
  },
  {
    project: "alfa",
    name: "bieżące",
    closed: false,
    state: {},
    updatedAt: NOW,
    items: [{ task: "Nowe", status: "open", fields: {}, updatedAt: NOW }],
  },
];

describe("statusCat", () => {
  test("rozpoznaje synonimy, nieznane to do zrobienia", () => {
    expect(["done", "Completed", "closed"].map(m.statusCat)).toEqual(["done", "done", "done"]);
    expect(["dropped", "cancelled", "wontfix"].map(m.statusCat)).toEqual(["dropped", "dropped", "dropped"]);
    expect(["blocked", "waiting"].map(m.statusCat)).toEqual(["blocked", "blocked"]);
    expect(["doing", "in_progress", "WIP"].map(m.statusCat)).toEqual(["doing", "doing", "doing"]);
    expect(["todo", "open", "", null, "przegląd"].map(m.statusCat)).toEqual(["todo", "todo", "todo", "todo", "todo"]);
  });
});

describe("flattenWork i summarize", () => {
  const { items, contexts } = m.flattenWork(lists);
  test("pozycje z zamkniętej listy są zakończone, kontekst bez status", () => {
    expect(items).toHaveLength(6);
    expect(items.find((i: any) => i.task === "Zapomniane w zamkniętej").cat).toBe("done");
    expect(items.find((i: any) => i.task === "Log przestoju").cat).toBe("doing");
    expect(contexts).toEqual([
      { project: "hipokamp", list: "wdrożenie", closed: false, state: { objective: "wdrożyć" }, updatedAt: NOW - DAY },
    ]);
  });
  test("liczby: otwarte, zalegające, projekty bez względu na wielkość liter", () => {
    const s = m.summarize(items, NOW);
    expect(s.by).toEqual({ blocked: 1, doing: 1, todo: 2, done: 2, dropped: 0 });
    expect(s.open).toBe(4);
    expect(s.completed).toBe(2);
    expect(s.stale).toBe(1); // tylko „Scalić PR” (20 dni), pozycje z zamkniętej listy nie zalegają
    expect(s.openProjects).toBe(2);
  });
  test("pusty wejściowy zbiór", () => {
    expect(m.summarize([], NOW).open).toBe(0);
    expect(m.flattenWork(undefined)).toEqual({ items: [], contexts: [] });
  });
});

describe("filterItems i sortItems", () => {
  const { items } = m.flattenWork(lists);
  test("domyślnie tylko otwarte, status done to zakończone", () => {
    expect(m.filterItems(items, {}, NOW)).toHaveLength(4);
    expect(m.filterItems(items, { status: "done" }, NOW)).toHaveLength(2);
    expect(m.filterItems(items, { status: "blocked" }, NOW).map((i: any) => i.task)).toEqual(["Hasło"]);
  });
  test("zalegające, projekt i tekst (także po polach i liście)", () => {
    expect(m.filterItems(items, { stale: true }, NOW).map((i: any) => i.task)).toEqual(["Scalić PR"]);
    expect(m.filterItems(items, { project: "ALFA" }, NOW).map((i: any) => i.task)).toEqual(["Nowe"]);
    expect(m.filterItems(items, { q: "SQUASH" }, NOW).map((i: any) => i.task)).toEqual(["Scalić PR"]);
    expect(m.filterItems(items, { q: "bieżące" }, NOW).map((i: any) => i.task)).toEqual(["Nowe"]);
  });
  test("sortowanie: zablokowane, w toku, do zrobienia, potem zakończone", () => {
    expect(m.sortItems(items).map((i: any) => i.cat)).toEqual(["blocked", "doing", "todo", "todo", "done", "done"]);
    const todos = m.sortItems(items).filter((i: any) => i.cat === "todo");
    expect(todos.map((i: any) => i.task)).toEqual(["Nowe", "Scalić PR"]); // świeższe pierwsze
  });
});

describe("klucz projektu", () => {
  test("fold zwija tylko ASCII, jak COLLATE NOCASE: Ż i ż to różne projekty", () => {
    expect(m.fold("Alfa")).toBe("alfa");
    expect(m.fold("Żaba")).not.toBe(m.fold("żaba"));
    const mk = (project: string) => ({
      project,
      name: "l",
      closed: false,
      state: {},
      updatedAt: NOW,
      items: [{ task: "t", status: "todo", fields: {}, updatedAt: NOW }],
    });
    const { items } = m.flattenWork([mk("Żaba"), mk("żaba"), mk("Beta"), mk("beta")]);
    expect(
      m
        .groupByProject(items)
        .map((g: any) => g.key)
        .sort(),
    ).toEqual(["Żaba", "beta", "żaba"].sort());
    expect(m.filterItems(items, { project: "BETA" }, NOW)).toHaveLength(2);
    expect(m.summarize(items, NOW).openProjects).toBe(3);
  });
});

describe("grupy i Markdown", () => {
  const { items } = m.flattenWork(lists);
  test("grupy po projekcie łączą pisownię, świeższy projekt pierwszy", () => {
    const g = m.groupByProject(m.filterItems(items, {}, NOW));
    expect(g.map((x: any) => x.key)).toEqual(["alfa", "hipokamp"]);
    expect(g[1].items).toHaveLength(3);
    expect(m.groupByList(g[1].items).map((l: any) => l.name)).toEqual(["wdrożenie"]);
  });
  test("grupy po statusie w stałej kolejności bez pustych", () => {
    expect(m.groupByStatus(items).map((g: any) => g.cat)).toEqual(["blocked", "doing", "todo", "done"]);
  });
  test("Markdown z dopiskami dla w toku i zablokowanych", () => {
    const md = m.toMarkdown(m.filterItems(items, {}, NOW), { doing: "w toku", blocked: "zablokowane" });
    expect(md).toContain("## hipokamp");
    expect(md).toContain("### wdrożenie");
    expect(md).toContain("- [ ] Hasło (zablokowane)");
    expect(md).toContain("- [ ] Log przestoju (w toku)");
    expect(md).toContain("- [ ] Scalić PR");
    expect(m.toMarkdown(items, {})).toContain("- [x] Zrobione");
  });
});
