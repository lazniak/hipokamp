// Motyw przed pierwszym malowaniem, bez błysku. Ciemny domyślnie (zasada marki), jasny z wyboru
// zapamiętanego w localStorage pod kluczem hx-theme. Parametr ?motyw=jasny|ciemny ustawia motyw
// tylko na ten widok (zrzuty ekranu, podgląd), bez zapisywania wyboru.
(function () {
  var root = document.documentElement;
  var theme = null;
  try {
    var q = new URLSearchParams(window.location.search).get("motyw");
    if (q === "jasny") theme = "light";
    else if (q === "ciemny") theme = "dark";
    if (!theme) {
      var saved = window.localStorage.getItem("hx-theme");
      if (saved === "light" || saved === "dark") theme = saved;
    }
  } catch (e) {
    // tryb prywatny albo zablokowany storage: zostaje motyw ciemny
  }
  root.setAttribute("data-theme", theme || "dark");
  root.classList.add("js");
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta && theme === "light") meta.setAttribute("content", "#F6F3EC");
})();
