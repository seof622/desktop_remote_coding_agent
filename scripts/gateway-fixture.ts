interface FixtureMessage { role?: string; content?: unknown }

/** Match the latest user prompt, so delayed requests cannot pick up a newer test's state. */
export function gatewayFixtureCaseId(input: unknown): string | undefined {
  if (!Array.isArray(input)) return undefined;
  for (let index = input.length - 1; index >= 0; index--) {
    const message = input[index] as FixtureMessage | null;
    if (message?.role !== "user") continue;
    const content = message.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.map((part) => part && typeof part.text === "string" ? part.text : "").join("\n") : "";
    return text.match(/\bgateway-fixture-case-\d+\b/)?.[0];
  }
  return undefined;
}
