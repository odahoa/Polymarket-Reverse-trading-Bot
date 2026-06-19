import type { BotConfig } from "./config.js";
import type { MarketScanner } from "./market-scanner.js";
import type { TradeOpportunity, TokenBook, UpDownEvent } from "./types.js";

function computeSize(usdcBudget: number, price: number, maxShares: number): number {
  const shares = usdcBudget / Math.max(price, 0.01);
  const capped = Math.min(shares, maxShares);
  return Math.max(1, Math.floor(capped * 100) / 100);
}

function cheapLimitPrices(config: BotConfig): number[] {
  const prices: number[] = [];
  for (let p = config.cheapBuyMin; p <= config.cheapBuyMax + 0.0001; p += 0.01) {
    prices.push(Math.round(p * 100) / 100);
  }
  return prices;
}

function expensiveLimitPrices(config: BotConfig): number[] {
  const prices: number[] = [];
  for (let p = config.expensiveBuyMin; p <= config.expensiveBuyMax + 0.0001; p += 0.01) {
    prices.push(Math.round(p * 100) / 100);
  }
  return prices;
}

function pickReverseToken(books: TokenBook[]): TokenBook | null {
  const withAsk = books.filter((book) => book.bestAsk !== null);
  if (withAsk.length === 0) return null;

  // Reverse side = the cheaper outcome (underdog / reversal bet)
  return withAsk.reduce((cheapest, book) =>
    (book.bestAsk ?? 1) < (cheapest.bestAsk ?? 1) ? book : cheapest,
  );
}

function buildOpportunity(
  kind: "cheap" | "expensive",
  event: UpDownEvent,
  token: TokenBook,
  price: number,
  usdcBudget: number,
  maxShares: number,
  scanner: MarketScanner,
): TradeOpportunity {
  return {
    kind,
    event,
    token,
    price,
    size: computeSize(usdcBudget, price, maxShares),
    tickSize: scanner.getTickSize(event.market),
    negRisk: event.market.negRisk,
  };
}

export function findOpportunities(
  config: BotConfig,
  scanner: MarketScanner,
  event: UpDownEvent,
  books: TokenBook[],
): TradeOpportunity[] {
  const opportunities: TradeOpportunity[] = [];

  const reverseToken = pickReverseToken(books);
  if (reverseToken) {
    for (const price of cheapLimitPrices(config)) {
      const key = scanner.makeTradeKey(event.slug, reverseToken.outcome, `cheap-${price}`);
      if (scanner.hasTraded(key)) continue;

      opportunities.push(
        buildOpportunity(
          "cheap",
          event,
          reverseToken,
          price,
          config.cheapOrderUsdc,
          config.maxSharesPerOrder,
          scanner,
        ),
      );
    }
  }

  if (config.enableExpensiveHedge && reverseToken) {
    const favoriteToken = books.find(
      (book) => book.tokenId !== reverseToken.tokenId && book.bestAsk !== null,
    );
    if (favoriteToken) {
      for (const price of expensiveLimitPrices(config)) {
        const key = scanner.makeTradeKey(
          event.slug,
          favoriteToken.outcome,
          `expensive-${price}`,
        );
        if (scanner.hasTraded(key)) continue;

        opportunities.push(
          buildOpportunity(
            "expensive",
            event,
            favoriteToken,
            price,
            config.expensiveOrderUsdc,
            config.maxSharesPerOrder,
            scanner,
          ),
        );
      }
    }
  }

  return opportunities;
}
