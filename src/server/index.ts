import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { checkFfmpeg } from "./remux.js";
import { createStorage } from "./storage/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!(await checkFfmpeg(config.ffmpegPath))) {
    console.warn(`warning: '${config.ffmpegPath}' is not runnable; sessions will record but tracks cannot be remuxed (set FFMPEG_PATH)`);
  }
  const { server, collector, post } = createApp(config, createStorage(config));
  server.listen(config.port, config.host, () => {
    console.log(`syncrecord collector listening on http://${config.host}:${config.port} (storage: ${config.storageDriver})`);
  });

  const stop = (): void => {
    console.log("shutting down");
    collector.close();
    server.close(() => {
      void Promise.all([collector.idle(), post.close()]).then(() => process.exit(0));
    });
    server.closeAllConnections();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
