import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { GatewayService } from "./gateway.js";
import { CodexProvider } from "./provider.js";
import { GatewayStore } from "./store.js";

const config = loadConfig();
const store = new GatewayStore(config.dataDir);
const provider = new CodexProvider(config);
const gateway = new GatewayService(store, provider);
const app = await buildApp({ config, gateway });

const stop = async () => {
  await app.close();
  await provider.close();
  store.close();
};
process.once("SIGINT", () => { void stop().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });

await app.listen({ host: config.bindHost, port: config.port });
