import { useEffect, useState } from "react";
import { useStore } from "../store";

// Roadmap step 2a-ii: the walk-mode buttons and hints, over the scene (DOM, not 3D). Static, not lazy:
// it must catch V before the WalkControls chunk has loaded. The walking itself is in WalkControls.tsx.

/** The stop switch: false hides the 🚶 button and ignores ?view=walk (App.tsx). */
export const WALK_ENABLED = true;

/** Walk mode needs a mouse (touch waits for the mobile round); ?view=walk checks this too. */
export const canWalk = () => WALK_ENABLED && typeof matchMedia === "function" && matchMedia("(any-pointer: fine)").matches;

/** Keys typed into a field are the boss's text, never walking or V. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
}

/** Hovering or focusing 🚶 loads the walk chunk early (the same chunk as OfficeScene's lazy()), so the first
 * click shows no blank Suspense frame. V doesn't: it's instant intent. */
let walkChunk: Promise<unknown> | null = null;
const prefetchWalk = () => {
  walkChunk ??= import("./WalkControls").catch(() => (walkChunk = null)); // a failed fetch can try again
};

const sceneCanvas = () => document.querySelector<HTMLCanvasElement>(".scene-canvas canvas");

/** Pointer lock, raw mouse movement where supported (no OS acceleration), plain lock where not. */
export function requestLook() {
  const canvas = sceneCanvas();
  if (!canvas) return;
  try {
    const p = canvas.requestPointerLock({ unadjustedMovement: true } as never) as unknown as Promise<void> | undefined;
    p?.catch?.(() => canvas.requestPointerLock());
  } catch {
    canvas.requestPointerLock();
  }
}

export function WalkHud() {
  const walking = useStore((s) => s.viewMode === "walk");
  const setViewMode = useStore((s) => s.setViewMode);
  const note = useStore((s) => s.walkNote);
  const place = useStore((s) => s.walkPlace); // round 13: the street you stand on (WalkControls)
  // The raw snapshot: what the sticky toast and the manager count.
  const asking = useStore((s) => s.snapshot?.tasks.filter((t) => t.approval).length ?? 0);
  // R6: what E would use where you stand (WalkControls writes it on a change). A gone department shows nothing.
  // Round 10: no prompt while a window or task card is open (E is ignored then, WalkControls).
  const use = useStore((s) => {
    if (s.modal || s.selectedTaskId) return null;
    const t = s.walkTarget;
    if (!t) return null;
    if (t.kind === "desk") return "Sit down · office view";
    const name = s.snapshot?.departments.find((d) => d.id === t.id)?.name;
    return name ? `Open ${name}` : null;
  });
  const [locked, setLocked] = useState(false);
  const [allowed] = useState(canWalk);

  // V toggles the view. Never while typing, with a modifier (Ctrl+V pastes), on a held key or with a window open.
  useEffect(() => {
    if (!allowed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyV" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const { modal, viewMode } = useStore.getState();
      if (modal) return;
      if (viewMode === "walk") document.exitPointerLock?.();
      setViewMode(viewMode === "walk" ? "office" : "walk");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [allowed, setViewMode]);

  useEffect(() => {
    const onChange = () => {
      const now = document.pointerLockElement === sceneCanvas();
      setLocked(now);
      // A refused raw-mouse lock can fire an error before the plain fallback works: the lock wins.
      if (now && useStore.getState().walkNote) useStore.setState({ walkNote: null });
    };
    const onError = () => useStore.setState({ walkNote: "Mouse look isn't available here · drag to look, or ← → to turn" });
    document.addEventListener("pointerlockchange", onChange);
    document.addEventListener("pointerlockerror", onError);
    return () => {
      document.removeEventListener("pointerlockchange", onChange);
      document.removeEventListener("pointerlockerror", onError);
    };
  }, []);

  if (!allowed) return null;
  if (!walking)
    return (
      <button
        className="btn btn--sm walk-btn"
        onClick={() => setViewMode("walk")}
        onPointerEnter={prefetchWalk}
        onFocus={prefetchWalk}
        title="Walk around (V)"
      >
        🚶 Walk <kbd className="walk-btn__key">V</kbd>
      </button>
    );
  return (
    <>
      {/* With the lock refused (note set), there's no layer: the canvas takes drags instead (WalkControls). */}
      {!locked && !note && (
        <button className="walk-lock" onClick={requestLook}>
          <span>Click to look around</span>
          <small>V or ⬅ Office view to leave</small>
        </button>
      )}
      {locked && <div className="walk-dot" aria-hidden />}
      <button
        className="btn btn--sm walk-btn"
        onClick={() => {
          document.exitPointerLock?.();
          setViewMode("office");
        }}
        title="Back to the office view (V)"
      >
        ⬅ Office view
      </button>
      {/* Fades 6 s into each lock (the key restarts the animation); shown in full while unlocked. */}
      <div key={locked ? "l" : "u"} className={locked ? "walk-hint walk-hint--fade" : "walk-hint"}>
        WASD move · Shift run · mouse look · ← → turn · E use · R desk · V back
      </div>
      {/* Just under the centre dot: the toasts (fixed, bottom-centre) would cover it lower down. */}
      {use && (
        <div className="walk-use" role="status">
          <kbd>E</kbd> {use}
        </div>
      )}
      {note && <div className="walk-note">{note}</div>}
      {place && (
        <div className="walk-place" role="status">
          📍 {place}
        </div>
      )}
      {/* Not a button: the toast stays the one place to answer. */}
      {asking > 0 && (
        <div className="walk-ask" role="status">
          ✋ {asking} need{asking === 1 ? "s" : ""} your OK · click the toast
        </div>
      )}
    </>
  );
}
