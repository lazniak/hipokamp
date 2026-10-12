// Ładowany przed każdym plikiem testów (bunfig.toml). Nadrabianie i backfill czytają też sesje innych harnessów
// (Gemini CLI, Cursor, OpenCode, Claude Desktop) z katalogu domowego: testy nigdy nie czytają prawdziwych, tylko
// katalog z „hipokamp-test” w nazwie (nie musi istnieć). Procesy potomne testów dziedziczą zmienną; test harnessów
// podmienia HOME, USERPROFILE i APPDATA sam.
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.HIPOKAMP_HARNESS_HOME?.includes("hipokamp-test"))
  process.env.HIPOKAMP_HARNESS_HOME = join(tmpdir(), "hipokamp-test-harness-home");
