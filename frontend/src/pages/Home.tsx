import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  listMounts, searchFiles, getDownloadUrl, Mount, SearchResult,
  listArchive, getArchiveDownloadUrl, getArchiveUploadUrl, deleteArchiveFile, ArchiveFile,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { FileThumb } from "../components/FileThumb";
import { MediaPlayer } from "../components/MediaPlayer";
import { ImageViewer } from "../components/ImageViewer";
import { ArchivePublicCell } from "../components/ArchivePublicCell";
import { categoryFor } from "../lib/fileTypes";
import { useDropUpload } from "../lib/useDropUpload";
import { DownloadIcon, TrashIcon } from "../lib/icons";

function fmtBytes(n: number) {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v > 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

export default function Home() {
  const { idToken } = useAuth();
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [archiveFiles, setArchiveFiles] = useState<ArchiveFile[]>([]);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  // Global search.
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ url: string; name: string; kind: "video" | "audio" } | null>(null);
  const [viewingImage, setViewingImage] = useState<{ url: string; name: string } | null>(null);

  useEffect(() => {
    if (!idToken) return;
    listMounts(idToken)
      .then((r) => setMounts(r.mounts))
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
    // Best-effort, separate from the main mounts load/error state -- this is
    // a nice-to-have shortcut to whatever's been shared into the app from
    // elsewhere (e.g. the mobile app's Share Extension), not core to the page.
    listArchive(idToken)
      .then((r) => setArchiveFiles(r.files))
      .catch(() => setArchiveFiles([]));
  }, [idToken]);

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idToken) return;
    const term = q.trim();
    if (!term) { setResults(null); return; }
    setSearching(true); setSearchErr(null);
    try {
      const r = await searchFiles(idToken, term);
      setResults(r.results);
      setTruncated(r.truncated);
    } catch (e: any) { setSearchErr(e.message); }
    finally { setSearching(false); }
  };

  const download = async (mountPath: string, path: string) => {
    if (!idToken) return;
    try {
      const { downloadUrl } = await getDownloadUrl(idToken, mountPath, path, true);
      window.location.assign(downloadUrl);
    } catch (e: any) { alert(e.message ?? "Download failed"); }
  };

  const downloadArchived = async (key: string) => {
    if (!idToken) return;
    try {
      const { downloadUrl } = await getArchiveDownloadUrl(idToken, key, true);
      window.location.assign(downloadUrl);
    } catch (e: any) { alert(e.message ?? "Download failed"); }
  };

  const removeArchived = async (f: ArchiveFile) => {
    if (!idToken) return;
    if (!confirm(`Permanently delete "${f.name}"? This deletes the file from S3 and cannot be undone.`)) return;
    try {
      await deleteArchiveFile(idToken, f.key);
      setArchiveFiles((prev) => prev.filter((x) => x.key !== f.key));
    } catch (e: any) {
      alert(e.message ?? "Delete failed");
    }
  };

  const play = async (f: SearchResult, kind: "video" | "audio") => {
    if (!idToken) return;
    try {
      const { downloadUrl, filename } = await getDownloadUrl(idToken, f.mountPath, f.path);
      setPlaying({ url: downloadUrl, name: filename ?? f.name, kind });
    } catch (e: any) { alert(e.message ?? "Couldn't open preview"); }
  };

  const viewImage = async (f: SearchResult) => {
    if (!idToken) return;
    try {
      const { downloadUrl, filename } = await getDownloadUrl(idToken, f.mountPath, f.path);
      setViewingImage({ url: downloadUrl, name: filename ?? f.name });
    } catch (e: any) { alert(e.message ?? "Couldn't open preview"); }
  };

  const playArchived = async (f: ArchiveFile, kind: "video" | "audio") => {
    if (!idToken) return;
    try {
      const { downloadUrl } = await getArchiveDownloadUrl(idToken, f.key);
      setPlaying({ url: downloadUrl, name: f.name, kind });
    } catch (e: any) { alert(e.message ?? "Couldn't open preview"); }
  };

  const viewArchiveImage = async (f: ArchiveFile) => {
    if (!idToken) return;
    try {
      const { downloadUrl } = await getArchiveDownloadUrl(idToken, f.key);
      setViewingImage({ url: downloadUrl, name: f.name });
    } catch (e: any) { alert(e.message ?? "Couldn't open preview"); }
  };

  // Drag-and-drop onto the home page uploads into the caller's own personal
  // folder (user_sharing_default/<email>/ — same target the mobile app's
  // Share Extension uses), not any particular mount.
  const uploadToArchive = async (list: File[]) => {
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
      const r = await listArchive(idToken);
      setArchiveFiles(r.files);
      setTimeout(() => setUploadMsg(null), 4000);
    } catch (e: any) {
      setUploadMsg(null);
      alert(e.message ?? "Upload failed");
    }
  };
  const { isDragging, dropProps } = useDropUpload(uploadToArchive);

  return (
    <div className="drop-zone-page" {...dropProps}>
      {isDragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-text">Drop to upload to your personal folder</div>
        </div>
      )}
      {uploadMsg && <p className="muted">{uploadMsg}</p>}
      <h2>Search files</h2>
      <form onSubmit={runSearch} style={{ display: "flex", gap: 8, maxWidth: 640 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search across all directories you can access…"
          autoComplete="off"
        />
        <button disabled={searching} style={{ whiteSpace: "nowrap" }}>
          {searching ? "Searching…" : "Search"}
        </button>
        {results !== null && (
          <button type="button" className="secondary" onClick={() => { setQ(""); setResults(null); }}>
            Clear
          </button>
        )}
      </form>
      {searchErr && <p className="err">{searchErr}</p>}

      {results !== null && (
        <div className="card" style={{ marginTop: "0.75rem" }}>
          {results.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No files match “{q.trim()}”.</p>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                {results.length} result{results.length === 1 ? "" : "s"}
                {truncated ? " (showing the first 200)" : ""}
              </p>
              <table>
                <thead><tr>
                  <th>Name</th><th>Directory</th><th style={{ width: 110 }}>Size</th><th style={{ width: 120 }}></th>
                </tr></thead>
                <tbody>
                  {results.map((f) => {
                    const cat = categoryFor(f.name);
                    const playable = cat === "video" || cat === "audio";
                    return (
                      <tr key={`${f.mountPath}/${f.path}`}>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <FileThumb
                              category={cat}
                              name={f.name}
                              loadUrl={() => getDownloadUrl(idToken!, f.mountPath, f.path).then((r) => r.downloadUrl)}
                              onPlay={playable ? () => play(f, cat as "video" | "audio") : undefined}
                              onOpen={cat === "image" ? () => viewImage(f) : undefined}
                              size={32}
                            />
                            {f.name}
                          </div>
                        </td>
                        <td className="muted">
                          <Link to={`/browse/${encodeURIComponent(f.mountPath)}?path=${encodeURIComponent(f.path.replace(/[^/]*$/, ""))}`}>
                            {f.mountName}
                          </Link>
                          {f.path.includes("/") ? <span className="muted"> / {f.path.replace(/\/[^/]*$/, "")}</span> : null}
                        </td>
                        <td>{fmtBytes(f.size)}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {playable && (
                            <button type="button" onClick={() => play(f, cat as "video" | "audio")} style={{ marginRight: 8 }}>
                              ▶ Play
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => download(f.mountPath, f.path)}
                            title="Download"
                            aria-label={`Download ${f.name}`}
                            style={{ padding: "6px 8px", display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}
                          >
                            <DownloadIcon />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      <h2 style={{ marginTop: "1.5rem" }}>Recently shared</h2>
      <p className="muted">Things you've shared into the app from elsewhere (e.g. the mobile app).</p>
      {archiveFiles.length > 0 && (
        <div className="file-list">
          {archiveFiles.slice(0, 5).map((f) => {
            const cat = categoryFor(f.name);
            const playable = cat === "video" || cat === "audio";
            return (
              <div className="file-row" key={f.key}>
                <FileThumb
                  category={cat}
                  name={f.name}
                  loadUrl={() => getArchiveDownloadUrl(idToken!, f.key).then((r) => r.downloadUrl)}
                  onPlay={playable ? () => playArchived(f, cat as "video" | "audio") : undefined}
                  onOpen={cat === "image" ? () => viewArchiveImage(f) : undefined}
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
                      onClick={() => downloadArchived(f.key)}
                      title="Download"
                      aria-label={`Download ${f.name}`}
                      style={{ padding: "6px 8px", display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}
                    >
                      <DownloadIcon />
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => removeArchived(f)}
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
        </div>
      )}
      {/* Always present (not just once there are files) -- a standing way to
          reach the full personal folder to browse or manage at any time. */}
      <p><Link to="/archive">More…</Link></p>

      <h2 style={{ marginTop: "1.5rem" }}>Shared directories</h2>
      <p className="muted">Pick a directory to browse.</p>
      {err && <p className="err">{err}</p>}
      {loading && <p className="muted">Loading…</p>}
      <div>
        {mounts.map((m) => (
          <div className="card" key={m.mountPath}>
            <h3 style={{ margin: 0 }}>
              <Link to={`/browse/${encodeURIComponent(m.mountPath)}`}>{m.displayName}</Link>
            </h3>
            <p className="muted" style={{ margin: "0.25rem 0 0" }}>
              <code>/{m.mountPath}</code>
              {m.description ? <> &middot; {m.description}</> : null}
            </p>
          </div>
        ))}
        {!loading && !mounts.length && (
          <div className="card">
            <p className="muted">No mounts configured yet. An admin can add one from the Admin page.</p>
          </div>
        )}
      </div>
      {playing && (
        <MediaPlayer url={playing.url} name={playing.name} kind={playing.kind} onClose={() => setPlaying(null)} />
      )}
      {viewingImage && (
        <ImageViewer url={viewingImage.url} name={viewingImage.name} onClose={() => setViewingImage(null)} />
      )}
    </div>
  );
}
