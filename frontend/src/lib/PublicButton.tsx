import { ClipboardIcon, YELLOW } from "./icons";

/**
 * The per-file "Public" toggle. When public, the button fills yellow and the
 * copy-link icon sits *inside* the button: clicking the icon copies the link
 * (stopPropagation), clicking the rest of the button makes the file private.
 * When private, it's yellow lettering with no icon.
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
        padding: "4px 10px",
        borderRadius: 6,
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        cursor: busy ? "default" : "pointer",
      }}
    >
      Public
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
