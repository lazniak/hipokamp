// get_tool_uses: surowe wejście i wyjście narzędzi stojących za notatką (warstwa 4 przepływu).
// Notatki z importu claude-mem: jego tabela tool_uses (tylko odczyt). Notatki hipokampa: zakres bajtów transkryptu,
// więc nie trzymamy drugiej kopii 150 tys. wywołań. Sekrety i narzędzia prywatne są wycinane.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isPrivateTool as isPrivate } from "../capture/private-tools.ts";
import { clean } from "../capture/redact.ts";
import { groupTurns, readLinesFrom } from "../capture/transcript.ts";
import { refreshConfig } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import type { Observation } from "../types.ts";
import { truncate } from "../util/text.ts";
import { fmtTime } from "./format.ts";

export interface ToolUse {
  obsId: number | null;
  toolUseId: string;
  name: string;
  input: string;
  output: string;
  isError: boolean;
  at: number;
}

const MAX_IN = 2500;
const MAX_OUT = 4000;

export function claudeMemDbPath(): string {
  return process.env.CLAUDE_MEM_DB || join(homedir(), ".claude-mem", "claude-mem.db");
}

function fromClaudeMem(where: string, params: (string | number)[], limit: number, priv: string[]): ToolUse[] {
  const path = claudeMemDbPath();
  if (!existsSync(path)) return [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    db.run("PRAGMA busy_timeout = 2000");
    const rows = db
      .query(
        `SELECT observation_id, tool_use_id, tool_name, tool_input, tool_response, created_at_epoch FROM tool_uses WHERE ${where} ORDER BY created_at_epoch, id LIMIT ?`,
      )
      .all(...params, limit) as any[];
    return rows
      .filter((r) => !isPrivate(r.tool_name, priv))
      .map((r) => ({
        obsId: r.observation_id ?? null,
        toolUseId: r.tool_use_id,
        name: r.tool_name,
        input: truncate(clean(String(r.tool_input ?? "")), MAX_IN),
        output: truncate(clean(String(r.tool_response ?? "")), MAX_OUT),
        isError: false,
        at: r.created_at_epoch,
      }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function fromTranscript(o: Observation, limit: number, priv: string[]): ToolUse[] {
  const ref = o.transcript_ref;
  if (!ref || !existsSync(ref.path)) return [];
  const { lines } = readLinesFrom(ref.path, ref.from, Math.max(1, ref.to - ref.from) + 1);
  const { turns } = groupTurns(
    lines.filter((l) => l.end <= ref.to),
    o.session_id ?? "",
    { final: true },
  );
  const out: ToolUse[] = [];
  for (const t of turns)
    for (const c of t.tools) {
      if (isPrivate(c.name, priv)) continue;
      out.push({
        obsId: o.id,
        toolUseId: c.id,
        name: c.name,
        input: truncate(clean(JSON.stringify(c.input)), MAX_IN),
        output: truncate(clean(c.result ?? ""), MAX_OUT),
        isError: c.isError,
        at: c.at,
      });
      if (out.length >= limit) return out;
    }
  return out;
}

/** Zwraca markdown z surowymi wywołaniami dla podanych id notatek (liczby) albo id wywołań (toolu_...). */
export function getToolUses(
  repo: Repo,
  ids: (number | string)[],
  opts: { limit?: number; project?: string | null; contentSessionId?: string | null } = {},
): string {
  // serwer MCP żyje całą sesję: privateTools z pliku (zmiana działa od następnego wywołania, także w trybach command i native)
  const priv = refreshConfig().capture.privateTools;
  const limit = Math.max(1, Math.min(200, opts.limit ?? 20));
  const sections: string[] = [];
  const notes: string[] = [];
  let left = limit;

  for (const raw of ids) {
    if (left <= 0) break;
    const s = String(raw).trim().replace(/^#/, "");
    if (!s) continue;
    if (!/^\d+$/.test(s)) {
      // id pojedynczego wywołania (claude-mem: tool_use_id)
      const where = opts.contentSessionId ? "tool_use_id = ? AND content_session_id = ?" : "tool_use_id = ?";
      const uses = fromClaudeMem(where, opts.contentSessionId ? [s, opts.contentSessionId] : [s], left, priv);
      if (uses.length) sections.push(render(`wywołanie ${s}`, uses));
      else notes.push(`nie znaleziono wywołania ${s}`);
      left -= uses.length;
      continue;
    }
    const id = Number(s);
    const o = repo.getObservation(id);
    if (!o) {
      notes.push(`nie ma notatki #${id}`);
      continue;
    }
    if (opts.project && o.project.toLowerCase() !== opts.project.toLowerCase()) {
      notes.push(`#${id} należy do projektu ${o.project}`);
      continue;
    }
    let uses: ToolUse[] = [];
    let origin = "";
    if (o.transcript_ref) {
      uses = fromTranscript(o, left, priv);
      origin = "transkrypt";
    }
    if (!uses.length && o.source === "claude-mem") {
      // notatka zapisana pod nowym numerem (numer z claude-mem był zajęty): jej numer w claude-mem jest w meta.cm_id
      const cmId = Number(o.meta?.cm_id) || id;
      uses = fromClaudeMem("observation_id = ?", [cmId], left, priv);
      origin = "claude-mem";
      // starsze notatki nie mają powiązania — bierzemy wywołania z tego samego promptu tej samej sesji (numer promptu
      // w claude-mem: naprawa mogła przenumerować prompty claude-mem sesji, sessions.meta.cm_n)
      if (!uses.length && o.session_id && o.prompt_n) {
        const cmN = repo.cmOrigPromptN(o.session_id, o.prompt_n);
        uses = fromClaudeMem("content_session_id = ? AND prompt_number = ?", [o.session_id, cmN], left, priv);
        origin = "claude-mem, ten sam prompt";
      }
    }
    if (!uses.length) {
      notes.push(
        `#${id}: brak surowych wywołań (${o.source === "agent" ? "notatka z remember" : o.transcript_ref ? "transkrypt niedostępny" : "źródło bez zapisu narzędzi"})`,
      );
      continue;
    }
    left -= uses.length;
    sections.push(render(`#${id} ${truncate(o.title, 90)} (${origin})`, uses));
  }
  const out = sections.join("\n\n");
  const tail = notes.length ? `\n\n${notes.map((n) => `- ${n}`).join("\n")}` : "";
  return (out || "Brak surowych wywołań dla podanych id.") + tail;
}

function render(title: string, uses: ToolUse[]): string {
  const out = [`## ${title}: ${uses.length} wywołań`];
  for (const u of uses) {
    out.push(`### ${u.name} · ${u.at ? fmtTime(u.at) : "?"}${u.isError ? " · BŁĄD" : ""}`);
    out.push(`wejście: ${u.input}`);
    if (u.output) out.push(`wynik:\n${u.output}`);
  }
  return out.join("\n");
}
