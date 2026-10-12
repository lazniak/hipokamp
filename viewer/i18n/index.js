// hipokamp: słowniki podglądu. en.js i pl.js to interfejs ogólny, *-dash.js to widok Dashboard.
import en from "./en.js";
import enDash from "./en-dash.js";
import pl from "./pl.js";
import plDash from "./pl-dash.js";

export const DICTS = { en: { ...en, ...enDash }, pl: { ...pl, ...plDash } };
