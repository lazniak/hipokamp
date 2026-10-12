// Spike: rozkład pól transkryptu potrzebnych do parsera tur (bez treści).
import { readdirSync, statSync, readFileSync } from "fs";
import { join } from "path";

const root = join(process.env.USERPROFILE!, ".claude", "projects");
const files: { p: string; m: number; s: number }[] = [];
for (const d of readdirSync(root)) {
  const dp = join(root, d);
  try {
    for (const f of readdirSync(dp)) if (f.endsWith(".jsonl")) { const st = statSync(join(dp, f)); files.push({ p: join(dp, f), m: st.mtimeMs, s: st.size }); }
  } catch {}
}
files.sort((a, b) => b.m - a.m);
const pick = files.filter((f) => f.s > 200_000 && f.s < 20_000_000).slice(0, 12);
const cnt = (o: Record<string, number>, k: string) => (o[k] = (o[k] || 0) + 1);
const promptSource: Record<string, number> = {}, origin: Record<string, number> = {}, turnOrigin: Record<string, number> = {};
const userShapes: Record<string, number> = {}, isMeta: Record<string, number> = {}, attachTypes: Record<string, number> = {};
const prefixes: Record<string, number> = {};
const turKeys: Record<string, Set<string>> = {};
const resultContentShape: Record<string, number> = {};
const inputKeys: Record<string, Set<string>> = {};
let subagentDirs = 0;
for (const f of pick) {
  for (const l of readFileSync(f.p, "utf8").split("\n")) {
    if (!l) continue;
    let j: any; try { j = JSON.parse(l); } catch { continue; }
    if (j.type === "attachment") cnt(attachTypes, j.attachment?.type ?? "?");
    if (j.type !== "user" && j.type !== "assistant") continue;
    if (j.type === "user") {
      cnt(promptSource, String(j.promptSource)); cnt(origin, JSON.stringify(j.origin)?.slice(0, 60) ?? "undefined"); cnt(turnOrigin, String(j.turnOrigin)); cnt(isMeta, String(j.isMeta));
      const c = j.message?.content;
      const shape = typeof c === "string" ? "string" : Array.isArray(c) ? c.map((b: any) => b.type).join("+") : typeof c;
      cnt(userShapes, shape.slice(0, 50));
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.find((b: any) => b.type === "text")?.text ?? "" : "";
      if (text) cnt(prefixes, text.trimStart().slice(0, 18).replace(/[a-ząćęłńóśźż0-9 ]/gi, "x"));
      if (j.toolUseResult && typeof j.toolUseResult === "object") {
        const tu = Array.isArray(c) ? c.find((b: any) => b.type === "tool_result") : null;
        const key = Object.keys(j.toolUseResult).sort().join(",").slice(0, 120);
        (turKeys[key] ??= new Set()).add("x");
        if (tu) cnt(resultContentShape, typeof tu.content === "string" ? "string" : Array.isArray(tu.content) ? "array:" + tu.content.map((b: any) => b.type).join("+").slice(0, 30) : typeof tu.content);
      }
    } else {
      for (const b of j.message?.content ?? []) if (b.type === "tool_use") (inputKeys[b.name] ??= new Set()).add(Object.keys(b.input ?? {}).sort().join(","));
    }
  }
}
for (const f of files.slice(0, 400)) { try { const sd = f.p.replace(/\.jsonl$/, ""); if (statSync(join(sd, "subagents")).isDirectory()) subagentDirs++; } catch {} }
console.log({ promptSource, origin, turnOrigin, isMeta, userShapes, attachTypes, resultContentShape, subagentDirs });
console.log("prompt prefixes (masked):", Object.entries(prefixes).sort((a, b) => b[1] - a[1]).slice(0, 25));
console.log("toolUseResult key shapes:", Object.keys(turKeys).slice(0, 30));
for (const [k, v] of Object.entries(inputKeys)) console.log("INPUT", k, [...v].slice(0, 3).join(" | "));
