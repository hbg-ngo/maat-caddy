export type Classification =
  | { kind: "assistant"; name: string }
  | { kind: "excluded_crawler"; name: string }
  | { kind: "other" };

/**
 * Extracts product names from a User-Agent string. A product is the part of a
 * token before "/" (e.g. "GPTBot/1.2" -> "gptbot"). Tokens are separated by
 * whitespace, ";", ",", "(" and ")", so products inside comments such as
 * "(compatible; GPTBot/1.2; +https://...)" are recognised.
 */
export function productNames(ua: string): string[] {
  const names: string[] = [];
  for (const token of ua.split(/[\s;,()]+/)) {
    if (token.length === 0) continue;
    const name = token.split("/", 1)[0]!;
    if (name.length > 0) names.push(name.toLowerCase());
  }
  return names;
}

export class Classifier {
  private readonly assistants: { lower: string; name: string }[];
  private readonly crawlers: Map<string, string>;

  constructor(assistants: readonly string[], crawlers: readonly string[]) {
    this.assistants = assistants.map((a) => ({ lower: a.toLowerCase(), name: a }));
    this.crawlers = new Map(crawlers.map((c) => [c.toLowerCase(), c]));
  }

  /**
   * Training-crawler exclusions are checked first and match whole product
   * names only. Assistants then match like Matomo's BotDetector
   * (case-insensitive substring of the full configured name, i.e. stripos),
   * so nothing Matomo would count as an AI assistant is skipped.
   */
  classify(ua: string): Classification {
    for (const n of productNames(ua)) {
      const crawler = this.crawlers.get(n);
      if (crawler !== undefined) return { kind: "excluded_crawler", name: crawler };
    }
    const lowerUa = ua.toLowerCase();
    for (const a of this.assistants) {
      if (lowerUa.includes(a.lower)) return { kind: "assistant", name: a.name };
    }
    return { kind: "other" };
  }
}
