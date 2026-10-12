// hipokamp: komunikaty błędów workera (src/worker/server.ts, bad("...")) są po polsku.
// Mapa: oryginalny komunikat PL -> klucz słownika err.server.*. W interfejsie angielskim api() pokazuje
// przetłumaczony komunikat, w polskim oryginał; nieznany komunikat zawsze wraca bez zmian.
// Ten plik ma polskie literały z założenia: to dane dopasowania, nie tekst interfejsu.
export default {
  "niedozwolony Host": "err.server.host",
  "niedozwolony Origin": "err.server.origin",
  "żądanie z obcej strony": "err.server.crossSite",
  "wymagany content-type: application/json": "err.server.contentType",
  "brak q": "err.server.noQuery",
  "nie ma takiej obserwacji": "err.server.noObservation",
  "nie ma takiej sesji": "err.server.noSession",
  "brak project": "err.server.noProject",
  "brak text": "err.server.noText",
  "wektory wyłączone w konfiguracji": "err.server.vectorsOff",
  "wymagane: project, list, fields": "err.server.workFields",
  "zła ścieżka": "err.server.badPath",
  "nie znaleziono": "err.server.notFound",
  "nieznany endpoint": "err.server.unknownEndpoint",
  "zły JSON": "err.server.badJson",
  "wymagane: ids (od 1 do 200 numerów notatek)": "err.server.ids",
  "reason musi być tekstem": "err.server.reason",
  "status: active, archived albo superseded (lista po przecinku)": "err.server.status",
  "za duże żądanie": "err.server.tooLarge",
  "złe potwierdzenie": "err.server.badAck",
  "nieznane zdarzenie": "err.server.unknownEvent",
  "wymagane wyzwanie: x-hipokamp-challenge (32 znaki hex)": "err.server.authChallenge",
  "brak klucza workera": "err.server.authNoKey",
  "uwierzytelnienie: nonce nieznany, zużyty albo przeterminowany, albo zły dowód klienta": "err.server.authFailed",
  "ta trasa wymaga uwierzytelnienia klucza workera (x-hipokamp-proof)": "err.server.authRequired",
  "podgląd wymaga ciasteczka: otwórz go przez hipokamp open": "err.server.viewerAuth",
  "zapis z podglądu wymaga nagłówka Origin": "err.server.viewerOrigin",
};
