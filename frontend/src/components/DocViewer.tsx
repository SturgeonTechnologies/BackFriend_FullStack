import { useEffect, useState } from "react";

interface DocViewerProps {
  kind: "pdf" | "text";
  url: string;
  name: string;
  onClose: () => void;
}

/** Full-screen PDF/text preview in the same modal chrome as MediaPlayer.
 * Click the backdrop (outside the panel) to close; clicks inside the panel
 * (scrolling the PDF, selecting text) don't close it. */
export function DocViewer({ kind, url, name, onClose }: DocViewerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="media-modal-backdrop" onClick={onClose}>
      <div className="media-modal doc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="media-modal-header">
          <span className="media-modal-title" title={name}>{name}</span>
          <button type="button" className="secondary media-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {kind === "pdf" ? (
          <iframe src={url} title={name} className="doc-viewer-frame" />
        ) : (
          <TextPreview url={url} />
        )}
      </div>
    </div>
  );
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
      .then((t) => {
        if (cancelled) return;
        setText(t.length > 200_000 ? `${t.slice(0, 200_000)}\n\n… (truncated)` : t);
      })
      .catch((e) => { if (!cancelled) setErr(e.message ?? "Couldn't load file"); });
    return () => { cancelled = true; };
  }, [url]);

  if (err) return <p className="err" style={{ padding: "1rem" }}>{err}</p>;
  if (text === null) return <p className="muted" style={{ padding: "1rem" }}>Loading…</p>;
  return <pre className="doc-viewer-text">{text}</pre>;
}
