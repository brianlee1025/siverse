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
  // The raw snapshot: what the sticky toast and the manager count.
  const asking = useStore((s) => s.snapshot?.tasks.filter((t) => t.approval).length ?? 0);
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
    const onChange = () => setLocked(document.pointerLockElement === sceneCanvas());
    const onError = () => useStore.setState({ walkNote: "Mouse look isn't available here · use ← → to turn" });
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
      <button className="btn btn--sm walk-btn" onClick={() => setViewMode("walk")} title="Walk around (V)">
        🚶 Walk
      </button>
    );
  return (
    <>
      {!locked && (
        <button className="walk-lock" onClick={requestLook}>
          <span>Click to look around</span>
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
      <div className="walk-hint">WASD move · Shift run · mouse look · ← → turn · V back</div>
      {note && <div className="walk-note">{note}</div>}
      {/* Not a button: the toast stays the one place to answer. */}
      {asking > 0 && (
        <div className="walk-ask" role="status">
          ✋ {asking} need{asking === 1 ? "s" : ""} your OK · click the toast
        </div>
      )}
    </>
  );
}
