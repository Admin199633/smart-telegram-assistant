import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";

const { app } = createApp();

app.listen(config.port, () => {
  logger.info("server started", { port: config.port });
});
