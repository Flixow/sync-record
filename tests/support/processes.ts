import { readFile, readdir } from "node:fs/promises";

/** Ids of the processes whose environment carries SYNCRECORD_JOB=<jobId> (Linux only). */
export async function processesOfJob(jobId: string): Promise<number[]> {
  const found: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const environ = await readFile(`/proc/${name}/environ`);
      if (environ.toString("utf8").split("\0").includes(`SYNCRECORD_JOB=${jobId}`)) found.push(Number(name));
    } catch {
      // gone or not ours
    }
  }
  return found;
}
