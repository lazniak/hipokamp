// `hipokamp sync …`: konfiguracja i ręczna synchronizacja z hubem. Żadna komenda nie wypisuje kluczy: klucz
// dostępu i klucze grupy leżą w state/sync-secret.json, a do nowego urządzenia idą zapieczętowane. Jedyny tekst do
// przepisania to jednorazowy kod dołączania z ekranu nowego urządzenia (ważny do zatwierdzenia, najwyżej 15 minut).
import { hostname } from "node:os";
import { join } from "node:path";
import { loadConfig, paths } from "../config.ts";
import { getDb } from "../db/db.ts";
import { Repo } from "../db/repo.ts";
import { call } from "../worker/client.ts";
import {
  approveJoin,
  createInvite,
  initSync,
  joinFinish,
  joinStart,
  leave,
  listDevices,
  listJoins,
  type PullResult,
  pendingJoin,
  pull,
  push,
  rejectJoin,
  resync,
  revokeDevice,
  SyncError,
  syncStatus,
} from "./client.ts";
import { sha256hex } from "./protocol.ts";

export const SYNC_HELP = `hipokamp sync: jedna pamięć na kilku komputerach przez własny hub (docs/SYNC.md)

  sync init --server <https://…> [--name nazwa]   pierwsze urządzenie grupy (sekret bootstrapu w HIPOKAMP_SYNC_BOOTSTRAP)
  sync join --server <https://…> [--name nazwa]   nowe urządzenie prosi o dołączenie, pokazuje kod i czeka [--wait s, domyślnie 600]
            [--invite hki_…]                      z zaproszeniem admina, gdy kolejka próśb jest zapchana
  sync join                                       dokończenie dołączania po zatwierdzeniu
  sync add-device <kod> [--admin]                 zatwierdza prośbę urządzenia, które pokazuje ten kod (rola admin)
            [--ack-lost-devices]                  po przywróceniu huba z kopii: urządzenia nieznane hubowi złożyły już prośby
  sync joins | sync reject <prośba>               oczekujące prośby, odrzucenie prośby (rola admin)
  sync invite                                     jednorazowe zaproszenie dla nowego urządzenia (rola admin, 15 minut)
  sync devices                                    urządzenia grupy
  sync revoke <numer>                             odcina urządzenie (pozostałe działają dalej)
  sync leave --yes [--abandon-group]              to urządzenie opuszcza grupę (baza zostaje; potem można sync join);
                                                  jedyny admin tylko z --abandon-group
  sync status                                     stan, zaległości, kursor, pominięte wpisy, urządzenia
  sync push | sync pull [--full] | sync now       wysyłka, odbiór, oba naraz
  sync resync                                     po przywróceniu huba z kopii: odbiór od początku i ponowna wysyłka
  sync bootstrap-hash                             skrót sekretu z HIPOKAMP_SYNC_BOOTSTRAP do konfiguracji huba
`;

const fmtTime = (t: number | null) => (t ? new Date(t).toLocaleString("pl-PL") : "nigdy");

function pulledLine(r: PullResult): string {
  const parts = [
    `wpisy ${r.entries}`,
    `notatki ${r.observations}`,
    `prompty ${r.prompts}`,
    `podsumowania ${r.summaries}`,
    `sesje ${r.sessions}`,
    `listy pracy ${r.workState}`,
    `statusy ${r.statuses}`,
    `pominięte (znane) ${r.skipped}`,
  ];
  if (r.bad) parts.push(`USZKODZONE ${r.bad}`);
  if (r.unreadable) parts.push(`NIECZYTELNE dla tej wersji ${r.unreadable} (wrócą po aktualizacji)`);
  if (r.rejected)
    parts.push(
      `ODRZUCONE operacje ${r.rejected}${r.future ? ` (w tym z zegarem ponad dobę przed zegarem tej maszyny: ${r.future}, zob. sync status)` : ""}`,
    );
  return parts.join(", ");
}

const problems = (r: PullResult) => r.bad > 0 || r.unreadable > 0 || r.rejected > 0;

export async function syncCommand(args: string[], say: (m: string) => void = console.log): Promise<number> {
  const sub = args[0] ?? "help";
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
    const eq = args.find((a) => a.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : undefined;
  };
  const has = (name: string) => args.includes(`--${name}`);
  const pos = args
    .slice(1)
    .filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--") && !all[i - 1].includes("=")));
  const ctx = () => ({ repo: new Repo(getDb()) });
  const deviceName = () => (flag("name") ?? hostname()).replace(/[^\p{L}\p{N} ._-]/gu, "-").slice(0, 40);
  const notify = async (r: PullResult) => {
    // nowe notatki bez wektorów: worker dolicza je sam, a powiadomienie tylko go budzi
    if (r.observations) await call("/api/notify", { body: { kind: "sync" }, timeoutMs: 500 });
  };

  try {
    switch (sub) {
      case "help":
      case "--help":
        say(SYNC_HELP);
        return 0;

      case "bootstrap-hash": {
        const s = process.env.HIPOKAMP_SYNC_BOOTSTRAP;
        if (!s) {
          say(
            "Brak zmiennej HIPOKAMP_SYNC_BOOTSTRAP. Wygeneruj losowy sekret (np. openssl rand -base64 32) i przekaż go w tej zmiennej; nie wklejaj go do czatu z modelem.",
          );
          return 1;
        }
        say(sha256hex(s));
        say("To skrót, nie sekret: wpisz go jako HIPOKAMP_SYNC_BOOTSTRAP_SHA256 w .env huba.");
        return 0;
      }

      case "init": {
        const server = flag("server");
        if (!server) {
          say("podaj --server https://… (adres huba)");
          return 1;
        }
        const st = await initSync(ctx(), {
          server,
          name: deviceName(),
          bootstrap: process.env.HIPOKAMP_SYNC_BOOTSTRAP ?? "",
        });
        say(`Grupa założona. To urządzenie: nr ${st.device} „${st.name}” (rola ${st.role}), hub ${st.server}.`);
        say(`Klucz grupy i klucz dostępu: ${join(paths.state(), "sync-secret.json")} (tylko dla Twojego konta).`);
        say("");
        say("Pierwsza wysyłka pamięci: hipokamp sync push");
        say('Synchronizacja w tle: w ~/.hipokamp/config.json ustaw "sync": { "enabled": true }');
        say("");
        say("Drugie urządzenie (klucze nie idą przez czat ani schowek):");
        say(`  1. na nim, w terminalu:  hipokamp sync join --server ${st.server} --name <nazwa>`);
        say("                           pokaże jednorazowy kod (16 znaków) i czeka");
        say("  2. tutaj:                hipokamp sync add-device <kod z tamtego ekranu>");
        say("  3. na nim samo się skończy (albo ponownie: hipokamp sync join), potem: hipokamp sync pull");
        say("Kod przepisz ręcznie: nie trafia do huba, a obie strony sprawdzają nim, że hub niczego nie podmienił.");
        say("Klucz grupy trafia do nowego urządzenia zaszyfrowany jego kluczem publicznym; hub go nie odczyta.");
        return 0;
      }

      case "join": {
        const c = ctx();
        let pj = pendingJoin(c);
        if (!pj) {
          const server = flag("server");
          if (!server) {
            say("podaj --server https://… (adres huba)");
            return 1;
          }
          const r = await joinStart(c, { server, name: deviceName(), invite: flag("invite") });
          pj = { ...r, server };
          say(`Prośba o dołączenie: ${r.request}`);
          say(`Kod dołączania:      ${r.code}`);
          say("");
          say("Na urządzeniu, które już jest w grupie (rola admin), uruchom:");
          say("  hipokamp sync add-device <kod dołączania>");
          say(
            `Kod przepisz ręcznie z tego ekranu; jest jednorazowy i nie trafia do huba. Prośba wygasa ${fmtTime(r.expires_at)}.`,
          );
        } else say(`Oczekująca prośba ${pj.request}, kod dołączania ${pj.code}.`);
        const waitS = Number(flag("wait") ?? "600");
        const until = Date.now() + Math.max(0, waitS) * 1000;
        for (;;) {
          const r = await joinFinish(c);
          if (r.status === "approved") {
            say(`Dołączono: urządzenie nr ${r.state.device} „${r.state.name}” (rola ${r.state.role}).`);
            say("Teraz: hipokamp sync pull (pamięć innych komputerów), potem hipokamp sync push.");
            return 0;
          }
          if (Date.now() >= until) {
            say("Jeszcze nie zatwierdzono. Po zatwierdzeniu uruchom ponownie: hipokamp sync join");
            return waitS > 0 ? 2 : 0;
          }
          await Bun.sleep(3000);
        }
      }

      case "add-device": {
        // kod jako argument (albo --code; wtedy argument to numer prośby, gdy trzeba go wskazać)
        const code = flag("code") ?? pos[0];
        const request = flag("code") ? pos[0] : flag("request");
        if (!code) {
          say("użycie: hipokamp sync add-device <kod z ekranu nowego urządzenia> [--admin]");
          return 1;
        }
        const r = await approveJoin(ctx(), { code, request, admin: has("admin"), ackLost: has("ack-lost-devices") });
        say(`Zatwierdzono: urządzenie nr ${r.device} „${r.name}” (rola ${r.role}). Na nim dołączanie skończy się samo.`);
        return 0;
      }

      case "joins": {
        const list = await listJoins(ctx());
        if (!list.length) say("Brak oczekujących próśb.");
        for (const j of list) say(`${j.request}  „${j.name}”  od ${fmtTime(j.created_at)}, wygasa ${fmtTime(j.expires_at)}`);
        if (list.length) say("Odrzucenie: hipokamp sync reject <prośba>; zatwierdzenie: hipokamp sync add-device <kod>.");
        return 0;
      }

      case "invite": {
        const r = await createInvite(ctx());
        say(`Zaproszenie: ${r.invite}`);
        say(`Na nowym urządzeniu: hipokamp sync join --server <adres huba> --invite ${r.invite}`);
        say(
          `Jednorazowe, ważne do ${fmtTime(r.expires_at)}. Pozwala tylko złożyć prośbę mimo zapchanej kolejki; zatwierdzenie nadal wymaga kodu z ekranu nowego urządzenia.`,
        );
        return 0;
      }

      case "leave": {
        if (!has("yes")) {
          say(
            "sync leave --yes: to urządzenie opuści grupę (skasuje lokalny klucz dostępu i klucze grupy; baza zostaje nietknięta). Potem można dołączyć od nowa: hipokamp sync join --server <adres>.",
          );
          return 1;
        }
        const r = await leave(ctx(), { abandonGroup: has("abandon-group") });
        say(`To urządzenie opuściło grupę${r.device ? ` (było nr ${r.device})` : ""}. Baza i notatki zostały.`);
        if (r.device)
          say(`Na urządzeniu z rolą admin odetnij stary numer: hipokamp sync revoke ${r.device} (jeśli hub go jeszcze zna).`);
        say(
          `Ponowne dołączenie: hipokamp sync join --server ${r.server ?? "<adres>"} (nowy numer; własne notatki pójdą jeszcze raz).`,
        );
        return 0;
      }

      case "reject": {
        if (!pos[0]) {
          say("użycie: hipokamp sync reject <prośba> (lista: hipokamp sync joins)");
          return 1;
        }
        await rejectJoin(ctx(), pos[0]);
        say(`Prośba ${pos[0]} odrzucona.`);
        return 0;
      }

      case "resync": {
        const r = await resync(ctx());
        say(
          `Ponowna synchronizacja: wysłane ${r.push.ops} operacji w ${r.push.entries} wpisach (powtórzone ${r.push.duplicates}); odebrane: ${pulledLine(r.pull)}`,
        );
        if (r.recovery) {
          say("Hub jest w trybie odzyskiwania (przywrócony z kopii). Dalej, w tej kolejności:");
          say("  1. hipokamp sync resync na KAŻDYM urządzeniu, które hub zna (wszystkie z rolą admin obowiązkowo);");
          say("  2. na każdym urządzeniu, którego hub nie zna (komunikat o nieznanym kluczu): hipokamp sync leave --yes,");
          say("     potem hipokamp sync join (prośba o dołączenie);");
          say(
            "  3. dopiero gdy wszystkie prośby czekają (hipokamp sync joins): hipokamp sync add-device <kod> --ack-lost-devices.",
          );
          say("Do kroku 3 hub nie zatwierdzi żadnego urządzenia (numer mógłby wrócić do użycia).");
        }
        await notify(r.pull);
        return problems(r.pull) ? 3 : 0;
      }

      case "devices": {
        for (const d of await listDevices(ctx()))
          say(
            `${String(d.no).padStart(3)}  ${d.name.padEnd(20)} ${d.role.padEnd(6)} ${d.status === "active" ? "aktywne " : "ODCIĘTE "} wpisy ${d.entries} (${(d.bytes / 1e6).toFixed(1)} MB), ostatnio ${fmtTime(d.last_seen_at)}`,
          );
        return 0;
      }

      case "revoke": {
        const no = Number(pos[0]);
        if (!Number.isInteger(no) || no < 1) {
          say("użycie: hipokamp sync revoke <numer urządzenia> (numery: hipokamp sync devices)");
          return 1;
        }
        await revokeDevice(ctx(), no);
        say(`Urządzenie nr ${no} odcięte: hub nie przyjmie od niego wpisów i nic mu nie wyda.`);
        say("Zna jednak klucz grupy i dawne wpisy, które już pobrało (docs/SYNC.md: odcięcie i rotacja klucza).");
        return 0;
      }

      case "push": {
        const r = await push(ctx());
        say(
          `wysłane: ${r.ops} operacji w ${r.entries} wpisach${r.duplicates ? ` (powtórzone: ${r.duplicates})` : ""}${r.skipped ? `; ZA DUŻE dla huba, pominięte: ${r.skipped} (sync status)` : ""}`,
        );
        return r.skipped ? 3 : 0;
      }

      case "pull": {
        const r = await pull(ctx(), { full: has("full") });
        say(`odebrane: ${pulledLine(r)}; kursor ${r.cursor}`);
        await notify(r);
        return problems(r) ? 3 : 0;
      }

      case "now": {
        const c = ctx();
        const p = await push(c);
        const r = await pull(c, { verify: false });
        say(`wysłane: ${p.ops} operacji w ${p.entries} wpisach; odebrane: ${pulledLine(r)}`);
        await notify(r);
        return problems(r) || p.skipped ? 3 : 0;
      }

      case "status": {
        const s = await syncStatus(ctx());
        if (!s.state) {
          say(
            s.join
              ? `Oczekująca prośba o dołączenie ${s.join.request} (kod dołączania ${s.join.code}) do ${s.join.server}; po zatwierdzeniu: hipokamp sync join`
              : "Synchronizacja nieskonfigurowana: hipokamp sync init (pierwsze urządzenie) albo hipokamp sync join.",
          );
          return 0;
        }
        const st = s.state;
        say(`hub:        ${st.server} (${st.hub})`);
        say(`urządzenie: nr ${st.device} „${st.name}”, rola ${st.role}; klucze grupy: ${s.kids.join(", ") || "BRAK"}`);
        say(
          `w tle:      ${s.enabled ? `włączona, co ${loadConfig().sync.intervalMin} min` : "wyłączona (sync.enabled w config.json)"}`,
        );
        say(
          `wysyłka:    ${fmtTime(s.lastPushAt)}; czeka: ${Object.entries(s.pending ?? {})
            .map(([k, v]) => `${k} ${v}`)
            .join(", ")}`,
        );
        say(`odbiór:     ${fmtTime(s.lastPullAt)}; kursor ${s.cursor}${s.head !== null ? ` z ${s.head}` : ""}`);
        if (s.bad.length) say(`USZKODZONE wpisy (pominięte): ${s.bad.join(", ")}`);
        if (s.unreadable.length)
          say(
            `NIECZYTELNE dla tej wersji wpisy (pominięte, wrócą same po aktualizacji hipokampa albo z nowym kluczem): ${s.unreadable
              .map((u) => `${u.seq} (${u.why === "kid" ? `klucz ${u.need}` : `wersja ${u.need}`})`)
              .join(", ")}`,
          );
        if (s.unreadableOlder)
          say(
            `NIECZYTELNE starsze wpisy (ponad listę): numery ${s.unreadableOlder.min} … ${s.unreadableOlder.max}; po aktualizacji odbiór przejrzy ten zakres jeszcze raz`,
          );
        if (s.skippedRows.length)
          say(
            `ZA DUŻE dla huba (nie wysłane): ${s.skippedRows.map((r) => `${r.t} ${r.ref} (${Math.round(r.bytes / 1024)} KB)`).join(", ")}`,
          );
        if (s.rollback) say(`WSTRZYMANA:  ${s.rollback}`);
        for (const w of s.clock) say(`ZEGAR:      ${w}`);
        if (s.recovery)
          say(
            "ODZYSKIWANIE: hub przywrócony z kopii; zatwierdzanie urządzeń czeka na resync każdego admina i add-device --ack-lost-devices (docs/SYNC.md, sekcja 9)",
          );
        if (s.error) say(`hub:        ${s.error}`);
        if (s.devices)
          for (const d of s.devices)
            say(
              `  ${d.no === st.device ? "*" : " "}${String(d.no).padStart(3)} ${d.name} (${d.role}) ${d.status === "active" ? "" : "ODCIĘTE "}ostatnio ${fmtTime(d.last_seen_at)}`,
            );
        return 0;
      }

      default:
        say(`nieznana komenda: sync ${sub}\n`);
        say(SYNC_HELP);
        return 1;
    }
  } catch (e) {
    say(e instanceof SyncError ? `sync: ${e.message}` : `sync: błąd: ${String((e as Error)?.message ?? e)}`);
    return 1;
  }
}
