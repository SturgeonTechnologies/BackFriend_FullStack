import { useEffect } from "react";

interface ImageViewerProps {
  url: string;
  name: string;
  onClose: () => void;
}

/** Full-screen image/gif preview with a darkened backdrop -- clicking or
 * tapping anywhere (including the image itself) closes it. */
export function ImageViewer({ url, name, onClose }: ImageViewerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="image-viewer-backdrop" onClick={onClose}>
      <img src={url} alt={name} title={name} className="image-viewer-img" />
    </div>
  );
}
