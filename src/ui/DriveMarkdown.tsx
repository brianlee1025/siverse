import Markdown from "react-markdown";
import { useStore } from "../store";

/**
 * The drive path a link points at, for relative links to another .md file (resolved against `base`,
 * a drive folder ending in "/"). Anything else, such as web links, anchors or images, gives null.
 * The server's resolveInside rejects paths that climb out of the drive, so a bad link just shows "No file".
 */
export function driveLink(href: string | undefined, base: string): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("#")) return null;
  const url = new URL(href, `http://d/${base}`);
  if (!/\.md$/i.test(url.pathname)) return null;
  return decodeURIComponent(url.pathname.slice(1));
}

/** Markdown from the drive, where links to other .md files open in the app instead of a dead browser tab. */
export function DriveMarkdown({ base, children }: { base: string; children: string }) {
  const openModal = useStore((s) => s.openModal);
  return (
    <Markdown
      components={{
        a: ({ href, children: label }) => {
          const path = driveLink(href, base);
          return path ? (
            <button type="button" className="link" onClick={() => openModal({ type: "file", path })}>
              {label}
            </button>
          ) : (
            <a href={href} target="_blank" rel="noreferrer">
              {label}
            </a>
          );
        },
      }}
    >
      {children}
    </Markdown>
  );
}
