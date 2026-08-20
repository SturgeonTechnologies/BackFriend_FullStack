import { useCallback, useEffect, useRef, useState } from "react";
import {
  listArchive, getArchiveDownloadUrl, getArchiveUploadUrl, deleteArchiveFile,
  ArchiveFile,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { useDropUpload } from "../lib/useDropUpload";
import { ArchivePublicCell } from "../components/ArchivePublicCell";
import { FileThumb } from "../components/FileThumb";
import { MediaPlayer } from "../components/MediaPlayer";
import { ImageViewer } from "../components/ImageViewer";
import { categoryFor } from "../lib/fileTypes";
import { DownloadIcon, TrashIcon, UploadIcon } from "../lib/icons";

function fmtBytes(n: number) {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v > 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Full view of the caller's own user_sharing_default/<email>/ folder -- the
 * "More…" destination from Home's Recently shared preview, so there's always
 * somewhere to go look at (and manage) everything in it, not just the last 5. */
export default function Archive() {
  const { idToken, email } = useAuth();
  const [files, setFiles] = useState<ArchiveFile[]>([]);
  const [nextToken, setNextToken] = useState<string | undefined>(undefined);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ url: string; name: string; kind: "video" | "audio" } | null>(null);
  const [viewingImage, setViewingImage] = useState<{ url: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFirstPage = useCallback(async () => {
    if (!idToken) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await listArchive(idToken);
      setFiles(r.files);
      setTruncated(r.truncated);
      setNextToken(r.nextToken);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [idToken]);

  useEffect(() => { loadFirstPage(); }, [loadFirstPage]);

  const loadMore = async () => {
    if (!idToken || !nextToken) return;
    setLoadingMore(true);
    try {
      const r = await listArchive(idToken, nextToken);
      setFiles((prev) => [...prev, ...r.files]);
      setTruncated(r.truncated);
      setNextToken(r.nextToken);
    } catch (e: any) {
      alert(e.message ?? "Couldn't load more");
    } finally {
      setLoadingMore(false);
    }
  };

  const uploadFiles = async (list: File[]) => {
    if (!idToken || !list.length) return;
    let done = 0;
    setUploadMsg(`Uploading 0/${list.length}…`);
    try {
      for (const file of list) {
        const { uploadUrl } = await getArchiveUploadUrl(idToken, file.name);
        const res = await fetch(uploadUrl, { method: "PUT", body: file });
        if (!res.ok) throw new Error(`Upload failed for ${file.name} (HTTP ${res.status})`);
        done++;
        setUploadMsg(`Uploading ${done}/${list.length}…`);
      }
      setUploadMsg(`Uploaded ${done} file${done === 1 ? "" : "s"}.`);
      await loadFirstPage();
      setTimeout(() => setUploadMsg(null), 4000);
    } catch (e: any) {
      setUploadMsg(null);
      alert(e.message ?? "Upload failed");
    }
  };

  const { isDragging, dropProps } = useDropUpload(uploadFiles);

  const onFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files;
    if (!picked || !picked.length) return;
    const list = Array.from(picked);
    e.target.value = "";
    await uploadFiles(list);
  };

  const download = async (key: string) => {
    if (!idToken) return;
    try {
      const { downloadUrl } = await getArchiveDownloadUrl(idToken, key, true);
      window.location.assign(downloadUrl);
    } catch (e: any) { alert(e.message ?? "Download failed"); }
  };

  const play = async (f: ArchiveFile, kind: "video" | "audio") => {
    if (!idToken) return;
    try {
      const { downloadUrl } = await getArchiveDownloadUrl(idToken, f.key);
      setPlaying({ url: downloadUrl, name: f.name, kind });
    } catch (e: any) { alert(e.message ?? "Couldn't open preview"); }
  };

  const viewImage = async (f: ArchiveFile) => {
    if (!idToken) return;
    try {
      const { downloadUrl } = await getArchiveDownloadUrl(idToken, f.key);
      setViewingImage({ url: downloadUrl, name: f.name });
    } catch (e: any) { alert(e.message ?? "Couldn't open preview"); }
  };

  const remove = async (f: ArchiveFile) => {
    if (!idToken) return;
    if (!confirm(`Permanently delete "${f.name}"? This deletes the file from S3 and cannot be undone.`)) return;
    try {
      await deleteArchiveFile(idToken, f.key);
      setFiles((prev) => prev.filter((x) => x.key !== f.key));
    } catch (e: any) {
      alert(e.message ?? "Delete failed");
    }
  };

  return (
    <div className="drop-zone-page" {...dropProps}>
      {isDragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-text">Drop to upload to your personal folder</div>
        </div>
      )}
      <h2>Your personal folder</h2>
      <p className="muted">
        Everything you've shared into the app from elsewhere (e.g. the mobile app), plus anything
        uploaded here{email ? ` -- private to ${email} unless you get a link` : ""}.
      </p>
      <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={onFilesSelected} />
      {err && <p className="err">{err}</p>}
      {uploadMsg && <p className="muted">{uploadMsg}</p>}
      {loading && <p className="muted">Loading…</p>}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.5rem" }}>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title="Add file(s)"
          aria-label="Add file(s)"
          style={{ background: "var(--success)", color: "#0b1f13", padding: "6px 8px", display: "inline-flex", alignItems: "center" }}
        >
          <UploadIcon />
        </button>
      </div>
      <div className="file-list">
        {files.map((f) => {
          const cat = categoryFor(f.name);
          const playable = cat === "video" || cat === "audio";
          return (
            <div className="file-row" key={f.key}>
              <FileThumb
                category={cat}
                name={f.name}
                loadUrl={() => getArchiveDownloadUrl(idToken!, f.key).then((r) => r.downloadUrl)}
                onPlay={playable ? () => play(f, cat as "video" | "audio") : undefined}
                onOpen={cat === "image" ? () => viewImage(f) : undefined}
              />
              <div className="file-row-main">
                <div className="file-row-top">
                  <span className="file-row-name" title={f.name}>{f.name}</span>
                  <span className="file-row-size muted">{fmtBytes(f.size)}</span>
                </div>
                <div className="file-row-bottom">
                  <span className="muted">{f.lastModified ? new Date(f.lastModified).toLocaleDateString() : "—"}</span>
                  <ArchivePublicCell file={f} />
                  <button
                    type="button"
                    onClick={() => download(f.key)}
                    title="Download"
                    aria-label={`Download ${f.name}`}
                    style={{ padding: "6px 8px", display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}
                  >
                    <DownloadIcon />
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => remove(f)}
                    title="Delete file"
                    aria-label={`Delete ${f.name}`}
                    style={{ padding: "6px 8px", display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {!loading && !files.length && (
          <p className="muted" style={{ padding: "1rem 0" }}>Nothing here yet.</p>
        )}
      </div>
      {truncated && (
        <p>
          <button type="button" className="secondary" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </p>
      )}
      {playing && (
        <MediaPlayer url={playing.url} name={playing.name} kind={playing.kind} onClose={() => setPlaying(null)} />
      )}
      {viewingImage && (
        <ImageViewer url={viewingImage.url} name={viewingImage.name} onClose={() => setViewingImage(null)} />
      )}
    </div>
  );
}
