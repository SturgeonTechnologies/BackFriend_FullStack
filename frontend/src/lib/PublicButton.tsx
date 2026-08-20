import { ClipboardIcon, ShareIcon, ShareFillIcon, YELLOW } from "./icons";

/**
 * The per-file "Public" toggle. When public, the button fills yellow with a
 * filled share icon, and the copy-link icon sits *inside* the button:
 * clicking the icon copies the link (stopPropagation), clicking the rest of
 * the button makes the file private. When private, it's an outline share
 * icon with no fill.
 */
export function PublicButton({
  isPublic, busy, copied, onToggle, onCopy,
}: {
  isPublic: boolean;
  busy?: boolean;
  copied?: boolean;
  onToggle: () => void;
  onCopy: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      title={isPublic ? "Public — click to make private" : "Make this file public"}
      style={{
        background: isPublic ? YELLOW : "transparent",
        color: isPublic ? "#1a1d23" : YELLOW,
        border: `1px solid ${YELLOW}`,
        padding: "6px 8px",
        borderRadius: 6,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        cursor: busy ? "default" : "pointer",
      }}
    >
      {isPublic ? <ShareFillIcon /> : <ShareIcon />}
      {isPublic && (
        <span
          role="button"
          aria-label="Copy public link"
          title="Copy public link"
          onClick={(e) => { e.stopPropagation(); onCopy(); }}
          style={{ display: "inline-flex", alignItems: "center", cursor: "pointer" }}
        >
          {copied ? <span style={{ fontSize: 12 }}>Copied!</span> : <ClipboardIcon />}
        </span>
      )}
    </button>
  );
}
