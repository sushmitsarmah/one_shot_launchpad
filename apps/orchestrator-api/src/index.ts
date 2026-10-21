import { app } from "./app";
import { config } from "./config";

console.log(
  `orchestrator-api on :${config.port} (llmMock=${config.llmMock}, nearMock=${config.nearMock}, vault=${config.vaultContract})`,
);

export default { port: config.port, fetch: app.fetch };
