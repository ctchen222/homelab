import { createServer } from "node:http";
import { createRequestHandler } from "./app";
import { loadConfig } from "./config";
import { AssistantStore } from "./storage";
import { PortfolioStore } from "./portfolioStore";

const config = loadConfig();
const store = new AssistantStore(config.assistantDbPath);
store.init();
const portfolioStore = new PortfolioStore(config.portfolioDbPath, {
  accountIdentitySalt: config.portfolioAccountIdentitySalt,
  writerLeaseMinutes: config.portfolioWriterLeaseMinutes
});
portfolioStore.init();

const server = createServer(
  createRequestHandler(config, store, {
    portfolioStore
  })
);

server.listen(config.port, () => {
  console.log(`finops-assistant listening on ${config.port}`);
});
