const SYSTEM = `Du schreibst ein Schweizerdeutsch-Transkript in sauberes Hochdeutsch um.
Regeln:
- Gib nur den hochdeutschen Text aus, ohne Anführungszeichen und ohne Erklärung.
- Erfinde nichts dazu und lass nichts Inhaltliches weg.
- Steht ein Ausdruck im Glossar, verwende genau die dort angegebene hochdeutsche Bedeutung.
- Löse Dialektgrammatik auf, inklusive Verbformen, Artikeln und Wortstellung.
- Zahlen und Eigennamen bleiben erhalten.`;

export function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data?.output ?? []) {
    for (const block of item.content ?? []) {
      if ((block.type === "output_text" || block.type === "text") && block.text) {
        parts.push(block.text);
      }
    }
  }
  return parts.join("").trim();
}

export async function rewriteToGerman(text, glossary, { apiKey, model, fetchImpl = fetch } = {}) {
  if (!apiKey) {
    throw new Error("XAI_API_KEY fehlt auf dem Server");
  }

  const glossaryBlock = glossary
    .map((entry) => `${entry.swiss.trim()} = ${entry.german.trim()}`)
    .join("\n");

  const response = await fetchImpl("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      store: false,
      input: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Glossar:\n${glossaryBlock}\n\nTranskript:\n${text}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data.error?.message || data.message || `Umschreibung fehlgeschlagen (${response.status})`;
    throw new Error(message);
  }

  const german = extractOutputText(data);
  if (!german) {
    throw new Error("Die Umschreibung war leer");
  }
  return german;
}
