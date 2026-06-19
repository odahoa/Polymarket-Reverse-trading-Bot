import type { BotConfig } from "./config.js";
import type { GammaMarket, OrderBook, TokenBook, UpDownEvent } from "./types.js";

const WINDOW_SECONDS = 15 * 60;

function parseJsonArray<T>(value: string): T[] {
  return JSON.parse(value) as T[];
}

function parseWindowStart(slug: string): number | null {
  const match = slug.match(/-(\d{10})$/);
  return match ? Number(match[1]) : null;
}

function matchesSlugPrefixes(slug: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => slug.startsWith(prefix));
}

function tickSizeFromMarket(market: GammaMarket): string {
  const tick = market.orderPriceMinTickSize ?? 0.01;
  if (tick >= 0.1) return "0.1";
  if (tick >= 0.01) return "0.01";
  return "0.001";
}

function bestPrice(levels: Array<{ price: string }> | undefined, mode: "bid" | "ask"): number | null {
  if (!levels || levels.length === 0) return null;
  const prices = levels.map((level) => Number(level.price)).filter((price) => !Number.isNaN(price));
  if (prices.length === 0) return null;
  return mode === "bid" ? Math.max(...prices) : Math.min(...prices);
}

export class MarketScanner {
  constructor(
    private readonly config: BotConfig,
    private readonly tradedKeys: Set<string>,
  ) {}

  async scan(): Promise<UpDownEvent[]> {
    const url = new URL("/events", this.config.gammaApiHost);
    url.searchParams.set("tag_slug", "15M");
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", "50");

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Gamma events API error: ${response.status}`);
    }

    const events = (await response.json()) as Array<{
      title: string;
      slug: string;
      markets: GammaMarket[];
    }>;

    const now = Math.floor(Date.now() / 1000);
    const results: UpDownEvent[] = [];

    for (const event of events) {
      if (!matchesSlugPrefixes(event.slug, this.config.marketSlugPrefixes)) continue;

      const market = event.markets[0];
      if (!market || market.closed || market.active === false) continue;

      const windowStart = parseWindowStart(event.slug);
      if (!windowStart) continue;

      const windowEnd = windowStart + WINDOW_SECONDS;
      if (now < windowStart || now > windowEnd) continue;

      const minutesLeft = (windowEnd - now) / 60;
      if (
        minutesLeft < this.config.minutesBeforeCloseMin ||
        minutesLeft > this.config.minutesBeforeCloseMax
      ) {
        continue;
      }

      results.push({
        title: event.title,
        slug: event.slug,
        market,
        windowStart,
        windowEnd,
      });
    }

    return results;
  }

  async getTokenBooks(event: UpDownEvent): Promise<TokenBook[]> {
    const tokenIds = parseJsonArray<string>(event.market.clobTokenIds);
    const outcomes = parseJsonArray<string>(event.market.outcomes);
    const books: TokenBook[] = [];

    for (let i = 0; i < tokenIds.length; i++) {
      const tokenId = tokenIds[i];
      if (!tokenId) continue;

      const book = await fetchOrderBook(this.config.clobHost, tokenId);
      books.push({
        tokenId,
        outcome: outcomes[i] ?? `Outcome ${i}`,
        outcomeIndex: i,
        bestBid: bestPrice(book.bids, "bid"),
        bestAsk: bestPrice(book.asks, "ask"),
      });
    }

    return books;
  }

  makeTradeKey(eventSlug: string, outcome: string, kind: string): string {
    return `${eventSlug}:${outcome}:${kind}`;
  }

  hasTraded(key: string): boolean {
    return this.tradedKeys.has(key);
  }

  markTraded(key: string): void {
    this.tradedKeys.add(key);
  }

  getTickSize(market: GammaMarket): string {
    return tickSizeFromMarket(market);
  }
}

async function fetchOrderBook(clobHost: string, tokenId: string): Promise<OrderBook> {
  const url = new URL("/book", clobHost);
  url.searchParams.set("token_id", tokenId);

  const response = await fetch(url);
  if (!response.ok) {
    return {};
  }

  return (await response.json()) as OrderBook;
}
