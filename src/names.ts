// Lowercase, accent- and punctuation-free name with suffixes removed: "Wan'Dale Robinson Jr." -> "wandale robinson".
export const normalizeName = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.'’`-]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();
