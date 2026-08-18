import { useEffect } from "react";

interface MediaPlayerProps {
  url: string;
  name: string;
  kind: "video" | "audio";
  onClose: () => void;
}

/** Full-screen-ish modal video/audio player, fed a presigned S3 GET URL. */
export function MediaPlayer({ url, name, kind, onClose }: MediaPlayerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="media-modal-backdrop" onClick={onClose}>
      <div className="media-modal" onClick={(e) => e.stopPropagation()}>
        <div className="media-modal-header">
          <span className="media-modal-title" title={name}>{name}</span>
          <button type="button" className="secondary media-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {kind === "video" ? (
          <video
            src={url}
            controls
            autoPlay
            playsInline
            style={{ width: "100%", maxHeight: "80vh", display: "block", background: "#000" }}
          />
        ) : (
          <audio src={url} controls autoPlay style={{ width: "100%", display: "block", padding: "1.2rem" }} />
        )}
      </div>
    </div>
  );
}
