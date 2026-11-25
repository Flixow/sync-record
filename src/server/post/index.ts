import { cpus } from "node:os";
import type { Config } from "../config.js";
import type { Storage } from "../storage/index.js";
import { FasterWhisperEngine, type AsrEngine } from "./asr.js";
import { conformHandler } from "./conform.js";
import { JobRunner, type JobHandler } from "./jobs.js";
import { ProjectStore } from "./projects.js";
import { thumbnailHandler } from "./thumbnail.js";
import { renderHandler } from "./render.js";
import { cutPreviewHandler } from "./render-audio.js";
import { transcribeHandler } from "./transcribe.js";

/** Everything post-production owns: the project store and the job queue with its handlers. */
export class PostProduction {
  readonly store: ProjectStore;
  readonly jobs: JobRunner;
  readonly asr: AsrEngine;
  /** Resolves when persisted jobs are loaded and the ones a crash interrupted are recovered. */
  readonly ready: Promise<void>;

  constructor(
    readonly config: Config,
    readonly storage: Storage,
    asr?: AsrEngine,
  ) {
    this.store = new ProjectStore(config, storage);
    this.asr = asr ?? new FasterWhisperEngine(config);
    const count = cpus().length;
    const handlers: Record<string, JobHandler> = {
      conform: conformHandler({ config, store: this.store, cpus: count }),
      thumbnail: thumbnailHandler({ config, store: this.store }),
      render: renderHandler({ config, store: this.store }),
      "cut-preview": cutPreviewHandler({ config, store: this.store }),
      transcribe: transcribeHandler({ config, store: this.store, engine: this.asr, cpus: count }),
    };
    this.jobs = new JobRunner(config.post, handlers, count);
    this.ready = this.jobs.init();
  }

  async idle(): Promise<void> {
    await this.ready;
    await this.jobs.idle();
  }

  async close(): Promise<void> {
    await this.ready.catch(() => undefined);
    await this.jobs.close();
  }
}
