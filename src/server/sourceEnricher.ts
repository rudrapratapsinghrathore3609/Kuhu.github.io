const AUTHORITATIVE = new Set([
  "rbi.org.in", "sebi.gov.in", "bseindia.com", "nseindia.com", "moneycontrol.com",
  "economictimes.indiatimes.com", "livemint.com", "financialexpress.com",
  "reuters.com", "bloomberg.com", "ft.com", "wsj.com", "cnbc.com", "marketwatch.com",
  "india.gov.in", "pib.gov.in", "nih.gov", "who.int", "worldbank.org",
  "arxiv.org", "nature.com", "science.org", "pubmed.ncbi.nlm.nih.gov",
  "github.com", "developer.mozilla.org", "docs.microsoft.com", "cloud.google.com"
]);

const NEWS = new Set([
  "bbc.com", "ndtv.com", "thehindu.com", "hindustantimes.com", "indiatoday.in",
  "techcrunch.com", "theverge.com", "wired.com", "arstechnica.com", "engadget.com",
  "towardsdatascience.com", "dev.to", "medium.com"
]);

const COMMUNITY = new Set([
  "reddit.com", "quora.com", "stackoverflow.com", "news.ycombinator.com"
]);

export type CredTier = "authoritative" | "news" | "community" | "unknown";
export type SourceType = "web" | "file" | "memory" | "model_knowledge";

export interface EnrichedSource {
  url: string;
  title: string;
  domain: string;
  favicon: string;
  publishedDate: string | null;
  excerpt: string;
  credibility: CredTier;
  type: SourceType;
  supportsClaim?: string;
}

export type RawSource = {
  url?: string;
  title?: string;
  snippet?: string;
  publishedDate?: string;
  type?: SourceType;
  claim?: string;
};

export function enrichSource(raw: RawSource): EnrichedSource {
  if (!raw.url || raw.type === "model_knowledge") {
    return {
      url: "",
      title: "Model knowledge",
      domain: "model",
      favicon: "",
      publishedDate: null,
      excerpt: "This response is based on the model's training data or app context, not a live external web source.",
      credibility: "unknown",
      type: "model_knowledge"
    };
  }

  let domain = "";
  try { domain = new URL(raw.url).hostname.replace(/^www\./, ""); }
  catch { domain = raw.url.split("/")[0]; }

  const credibility: CredTier = AUTHORITATIVE.has(domain)
    ? "authoritative"
    : NEWS.has(domain)
      ? "news"
      : COMMUNITY.has(domain)
        ? "community"
        : "unknown";

  const rawExcerpt = raw.snippet ?? "";
  const excerpt = rawExcerpt.length > 160
    ? `${rawExcerpt.slice(0, 159).replace(/\s\S*$/, "")}...`
    : rawExcerpt;

  return {
    url: raw.url,
    title: raw.title || domain,
    domain,
    favicon: `https://www.google.com/s2/favicons?domain=${domain}&sz=32`,
    publishedDate: raw.publishedDate ?? null,
    excerpt,
    credibility,
    type: raw.type ?? "web",
    supportsClaim: raw.claim
  };
}

export function enrichSources(raws: RawSource[]): EnrichedSource[] {
  if (!raws?.length) return [enrichSource({ type: "model_knowledge" })];
  return raws.map(enrichSource);
}

export function formatSourceLine(source: EnrichedSource) {
  return [
    `Source: ${source.title}`,
    `domain=${source.domain}`,
    `credibility=${source.credibility}`,
    `type=${source.type}`,
    `date=${source.publishedDate || "unknown"}`,
    source.url ? `url=${source.url}` : "url=none",
    source.excerpt ? `excerpt=${source.excerpt}` : "excerpt=none",
    source.supportsClaim ? `claim=${source.supportsClaim}` : "claim=not specified"
  ].join(" | ");
}