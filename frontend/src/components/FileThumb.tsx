import { useEffect, useRef, useState } from "react";
import { FileCategory, emojiFor } from "../lib/fileTypes";

interface FileThumbProps {
  category: FileCategory;
  name: string;
  /** Fetches a presigned GET URL for this file. Only called once the thumb scrolls into view. */
  loadUrl: () => Promise<string>;
  /** If set, the thumb becomes clickable (video/audio) and opens the player. */
  onPlay?: () => void;
  size?: number;
}

/**
 * Lazy file-row thumbnail: images render inline once scrolled into view;
 * videos grab a frame a second in (via a muted, seeked <video> element --
 * no canvas, so no CORS requirement on the shares bucket); everything else
 * falls back to a category emoji. Playable types get a ▶ overlay.
 */
export function FileThumb({ category, name, loadUrl, onPlay, size = 40 }: FileThumbProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || category === "other") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [category]);

  useEffect(() => {
    if (!inView || (category !== "image" && category !== "video") || url || failed) return;
    let cancelled = false;
    loadUrl()
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, category, url, failed]);

  const clickable = !!onPlay;
  const showMedia = !!url && !failed && (category === "image" || category === "video");

  const mediaStyle: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover", display: "block" };

  return (
    <div
      ref={ref}
      className="file-thumb"
      style={{ width: size, height: size, cursor: clickable ? "pointer" : "default" }}
      onClick={clickable ? onPlay : undefined}
      title={clickable ? `Play ${name}` : undefined}
    >
      {category === "image" && showMedia && (
        <img src={url!} alt="" loading="lazy" onError={() => setFailed(true)} style={mediaStyle} />
      )}
      {category === "video" && showMedia && (
        <video
          src={url!}
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            try { v.currentTime = Math.min(1, (v.duration || 2) * 0.1); } catch { /* not seekable yet */ }
          }}
          onError={() => setFailed(true)}
          style={mediaStyle}
        />
      )}
      {!showMedia && <span style={{ fontSize: size * 0.5, lineHeight: 1 }}>{emojiFor(category)}</span>}
      {clickable && <span className="file-thumb-play">▶</span>}
    </div>
  );
}
