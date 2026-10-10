import { useCallback, useEffect, useRef, useState } from "react";

// Half-typed text survives a reload or an office restart (which reloads the page during a code change).
// Kept in localStorage as { [key]: { text, at } }, newest MAX_DRAFTS only.

const DRAFTS_KEY = "siverse.drafts";
const MAX_DRAFTS = 20;
const WRITE_DELAY_MS = 300;

type Drafts = Record<string, { text: string; at: number }>;
let cache: Drafts | null = null;

function load(): Drafts {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}");
    cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Drafts) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save(key: string, text: string) {
  const all = load();
  if (text) all[key] = { text, at: Date.now() };
  else delete all[key];
  const keep = Object.entries(all)
    .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
    .slice(0, MAX_DRAFTS);
  cache = Object.fromEntries(keep);
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(cache));
  } catch {
    // Private mode or full storage: the draft just won't survive a reload.
  }
}

const stored = (key: string | null) => (key ? (load()[key]?.text ?? "") : "");

/** Like useState(""), but kept per key across reloads. Returns [text, setText, clear]; a null key keeps nothing. */
export function useDraft(key: string | null): [string, (text: string) => void, () => void] {
  const [text, setText] = useState(() => stored(key));
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    // Another task or department in the same component: show its own draft.
    setShownKey(key);
    setText(stored(key));
  }
  const pending = useRef<{ key: string; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (pending.current) save(pending.current.key, pending.current.text);
    pending.current = null;
  }, []);

  // Write what's pending when the key changes, the component goes, or the page unloads.
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [key, flush]);

  const set = useCallback(
    (next: string) => {
      setText(next);
      if (!key) return;
      pending.current = { key, text: next };
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, WRITE_DELAY_MS);
    },
    [key, flush],
  );

  const clear = useCallback(() => {
    setText("");
    clearTimeout(timer.current);
    pending.current = null;
    if (key) save(key, "");
  }, [key]);

  return [text, set, clear];
}
