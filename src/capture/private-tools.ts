// Narzędzia prywatne (capture.privateTools) w zapisie każdego harnessu. Wzorzec serwera MCP w zapisie Claude Code
// (`mcp__sejf__`) łapie też ten sam serwer w nazwach innych harnessów: Cursor `mcp_sejf_<narzędzie>`, Gemini CLI
// `sejf__<narzędzie>` (przy konflikcie nazw; bez konfliktu tłumacz sprowadza nazwę do `mcp__sejf__…` z displayName),
// OpenCode `sejf_<narzędzie>`. Wielkość liter bez znaczenia. Moduł bez importów: ładuje go też plugin OpenCode.

/** Postacie wzorca w nazwach narzędzi harnessów: [zawiera…, zaczyna się od…]. */
function variants(p: string): { has: string[]; starts: string[] } {
  const pat = p.toLowerCase();
  if (!pat.startsWith("mcp__")) return { has: [pat], starts: [] };
  const server = pat.slice(5).replace(/__$/, "");
  if (!server) return { has: [pat], starts: [] };
  return { has: [pat, `mcp_${server}_`, `${server}__`], starts: [`${server}_`] };
}

/** Czy narzędzie jest prywatne: jego wejście i wynik nigdy nie trafiają do pamięci. */
export function isPrivateTool(name: string, priv: readonly string[]): boolean {
  const n = String(name ?? "").toLowerCase();
  if (!n) return false;
  return priv.some((p) => {
    if (!p) return false;
    const v = variants(p);
    return v.has.some((x) => n.includes(x)) || v.starts.some((x) => n.startsWith(x));
  });
}
