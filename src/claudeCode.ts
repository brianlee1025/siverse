import type { Snapshot } from "../shared/types";

const LIVE_WINDOW_MS = 10 * 60_000;

/** True when Claude Code has reported something recently. */
export function claudeCodeIsLive(snapshot: Snapshot) {
  const last = snapshot.claudeCode.lastEventAt;
  return last !== null && Date.now() - last < LIVE_WINDOW_MS;
}
