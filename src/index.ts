import { loadConfig, validateTradingConfig } from "./config.js";
import { MarketScanner } from "./market-scanner.js";
import { findOpportunities } from "./strategy.js";
import { Trader } from "./trader.js";

function log(message: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  if (data) {
    console.log(`[${ts}] ${message}`, JSON.stringify(data));
  } else {
    console.log(`[${ts}] ${message}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  validateTradingConfig(config);

  const tradedKeys = new Set<string>();
  const scanner = new MarketScanner(config, tradedKeys);
  const trader = new Trader(config);
  await trader.init();

  log("Reverse bot starting", {
    strategy: "buy cheap reversal tokens on 15m BTC/ETH markets",
    cheapRange: `${config.cheapBuyMin}-${config.cheapBuyMax}`,
    expensiveHedge: config.enableExpensiveHedge
      ? `${config.expensiveBuyMin}-${config.expensiveBuyMax}`
      : "disabled",
    markets: config.marketSlugPrefixes,
    dryRun: config.dryRun,
    pollMs: config.pollIntervalMs,
  });

  const loop = async (): Promise<void> => {
    try {
      const events = await scanner.scan();
      if (events.length === 0) {
        log("No active markets in window");
        return;
      }

      for (const event of events) {
        const books = await scanner.getTokenBooks(event);
        const opportunities = findOpportunities(config, scanner, event, books);

        if (opportunities.length === 0) {
          log("Watching market", {
            market: event.title,
            slug: event.slug,
            books: books.map((book) => ({
              outcome: book.outcome,
              bestAsk: book.bestAsk,
            })),
          });
          continue;
        }

        for (const opportunity of opportunities) {
          const tradeKey = scanner.makeTradeKey(
            event.slug,
            opportunity.token.outcome,
            `${opportunity.kind}-${opportunity.price}`,
          );

          log("Placing limit order", {
            kind: opportunity.kind,
            market: event.title,
            outcome: opportunity.token.outcome,
            limitPrice: opportunity.price,
            size: opportunity.size,
            potentialReturn: `${Math.round((1 / opportunity.price - 1) * 100)}% if wins`,
          });

          const result = await trader.placeBuy(opportunity);
          scanner.markTraded(tradeKey);

          log(config.dryRun ? "Dry-run order" : "Live order placed", {
            tokenId: result.tokenId,
            price: result.price,
            size: result.size,
            response: result.response,
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Scan error", { error: message });
    }
  };

  await loop();
  setInterval(loop, config.pollIntervalMs);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
