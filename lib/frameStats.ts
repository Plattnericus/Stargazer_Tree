// Numbers behind the FPS overlay (components/FpsCounter.tsx). The probe inside
// the Canvas (FrameStatsProbe in components/Experience.tsx) writes them every
// frame, and only while the overlay is shown; the overlay reads them a few
// times a second. A plain mutable object, like cameraBus: no React state per
// frame.

export const FRAME_SAMPLES = 240;

export const frameStats = {
  /** Recent frame intervals in ms, a ring buffer (newest at head - 1). */
  intervals: new Float32Array(FRAME_SAMPLES),
  head: 0,
  count: 0,
  /** Draw calls and triangles of the last whole frame, shadow and post passes included. */
  calls: 0,
  triangles: 0,
  /** Drawing buffer size in device pixels, and the pixel ratio it was sized with. */
  width: 0,
  height: 0,
  dpr: 1,
};

export function resetFrameStats(): void {
  frameStats.head = 0;
  frameStats.count = 0;
}

export function recordFrame(ms: number): void {
  frameStats.intervals[frameStats.head] = ms;
  frameStats.head = (frameStats.head + 1) % FRAME_SAMPLES;
  if (frameStats.count < FRAME_SAMPLES) frameStats.count++;
}

export type FrameSummary = {
  fps: number;
  frameMs: number;
  /** Average fps over the slowest 1% of the recent frames. */
  low1: number;
};

/** FPS and frame time over the last `windowMs`, 1% low over every stored frame. */
export function summarizeFrames(windowMs = 500): FrameSummary | null {
  const { intervals, head, count } = frameStats;
  if (count === 0) return null;
  let sum = 0;
  let n = 0;
  while (n < count && sum < windowMs) {
    sum += intervals[(head - 1 - n + FRAME_SAMPLES) % FRAME_SAMPLES];
    n++;
  }
  const sorted = intervals.slice(0, count).sort();
  const worst = Math.max(1, Math.ceil(count / 100));
  let worstSum = 0;
  for (let i = count - worst; i < count; i++) worstSum += sorted[i];
  return {
    fps: (n * 1000) / sum,
    frameMs: sum / n,
    low1: (worst * 1000) / worstSum,
  };
}
