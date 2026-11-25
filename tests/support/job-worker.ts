// Runs a post-production job in a separate process so a test can kill it the hard way.
import { loadConfig } from "../../src/server/config.js";
import { PostProduction } from "../../src/server/post/index.js";
import { createStorage } from "../../src/server/storage/index.js";

const [mode, sid] = process.argv.slice(2);
const config = loadConfig();
const post = new PostProduction(config, createStorage(config));
await post.ready;
if (mode === "enqueue" && sid) {
  await post.store.create(sid);
  const job = await post.jobs.enqueue(sid, "conform");
  console.log(`JOB ${job.id}`);
}
await post.idle();
await post.close();
console.log("IDLE");
process.exit(0);
