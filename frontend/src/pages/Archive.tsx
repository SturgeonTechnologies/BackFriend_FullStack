import { useCallback, useEffect, useRef, useState } from "react";
import {
  listArchive, getArchiveDownloadUrl, getArchiveUploadUrl, deleteArchiveFile,
  ArchiveFile,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { useDropUpload } from "../lib/useDropUpload";
import { ArchivePublicCell } from "../components/ArchivePublicCell";
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
      const { downloadUrl } = await getArchiveDownloadUrl(idToken, key);
      window.location.assign(downloadUrl);
    } catch (e: any) { alert(e.message ?? "Download failed"); }
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
    <div {...dropProps}>
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
      <table>
        <thead><tr>
          <th>Name</th><th style={{ width: 110 }}>Size</th><th style={{ width: 180 }}>Modified</th>
          <th style={{ width: 160 }}>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Add file(s)"
              aria-label="Add file(s)"
              style={{ background: "var(--success)", color: "#0b1f13", padding: "6px 8px", display: "inline-flex", alignItems: "center" }}
            >
              <UploadIcon />
            </button>
          </th>
        </tr></thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.key}>
              <td>{f.name}</td>
              <td>{fmtBytes(f.size)}</td>
              <td className="muted">{f.lastModified ? new Date(f.lastModified).toLocaleDateString() : "—"}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                <span style={{ marginRight: 8 }}><ArchivePublicCell file={f} /></span>
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
                  style={{ marginLeft: 8, padding: "6px 8px", display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}
                >
                  <TrashIcon />
                </button>
              </td>
            </tr>
          ))}
          {!loading && !files.length && (
            <tr><td colSpan={4} className="muted" style={{ padding: "1rem" }}>Nothing here yet.</td></tr>
          )}
        </tbody>
      </table>
      {truncated && (
        <p>
          <button type="button" className="secondary" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </p>
      )}
    </div>
  );
}
