import "./workerGlobals";
import { generateBark } from "./barkTexture";
import { buildCanopy, type CanopyInput } from "./canopy";

// The tree's heavy procedural generation, off the main thread (see
// lib/treeWorkerClient.ts). Results go back as transferred typed arrays.
export type TreeJob = { kind: "canopy"; input: CanopyInput } | { kind: "bark"; size: number };

self.onmessage = (event: MessageEvent<TreeJob & { id: number }>) => {
  const job = event.data;
  if (job.kind === "bark") {
    const bark = generateBark(job.size);
    self.postMessage(
      { id: job.id, data: bark },
      { transfer: [bark.color.buffer, bark.bump.buffer, bark.rough.buffer] },
    );
    return;
  }
  const data = buildCanopy(job.input);
  const transfer: Transferable[] = [data.sprigs.buffer];
  if (data.branch) {
    transfer.push(
      data.branch.position.buffer,
      data.branch.normal.buffer,
      data.branch.uv.buffer,
      data.branch.index.buffer,
    );
  }
  self.postMessage({ id: job.id, data }, { transfer });
};
