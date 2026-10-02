import fs from "node:fs";

export function loadGlossary(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(data)) {
    throw new Error("glossary.json muss eine Liste sein");
  }

  return data.filter(
    (entry) =>
      entry &&
      typeof entry.swiss === "string" &&
      entry.swiss.trim() &&
      typeof entry.german === "string" &&
      entry.german.trim(),
  );
}

export function selectKeyterms(entries, limit = 100) {
  const seen = new Set();
  return entries
    .map((entry) => entry.swiss.trim())
    .filter((term) => term.length > 0 && term.length <= 50)
    .sort((a, b) => b.length - a.length)
    .filter((term) => {
      const key = term.toLocaleLowerCase("de-CH");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findMatches(text, entries) {
  return entries.filter((entry) => {
    const pattern = new RegExp(
      `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(entry.swiss.trim())}(?:$|[^\\p{L}\\p{N}])`,
      "iu",
    );
    return pattern.test(text);
  });
}
