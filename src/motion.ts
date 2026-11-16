// prefers-reduced-motion, kept current: turning the OS setting on mid-session works.
// Every scene motion that is decoration only (steam, doors, traffic, transitions) checks this.
import { useSyncExternalStore } from "react";

const query = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

/** Read in useFrame (no re-render). */
export const motion = { reduced: query?.matches ?? false };

const listeners = new Set<() => void>();
query?.addEventListener("change", (e) => {
  motion.reduced = e.matches;
  listeners.forEach((l) => l());
});

/** For components that render differently (not just per frame). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => motion.reduced,
  );
}
