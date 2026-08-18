import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  browseList, getDownloadUrl, setFilePublic, unsetFilePublic,
  getUploadUrl, deleteFile,
  BrowseFile, BrowseFolder,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { TrashIcon } from "../lib/icons";
import { PublicButton } from "../lib/PublicButton";
import { FileThumb } from "../components/FileThumb";
import { MediaPlayer } from "../components/MediaPlayer";
import { categoryFor } from "../lib/fileTypes";

function fmtBytes(n: number) {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v > 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Admin-only per-file public toggle + copy link. */
function PublicCell({ mountPath, file }: { mountPath: string; file: BrowseFile }) {
  const { idToken } = useAuth();
  const [isPublic, setIsPublic] = useState(!!file.public);
  const [url, setUrl] = useState<string | undefined>(file.publicUrl);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const toggle = async () => {
    if (!idToken || busy) return;
    setBusy(true);
    try {
      if (isPublic) {
        await unsetFilePublic(idToken, mountPath, file.path);
        setIsPublic(false); setUrl(undefined);
      } else {
        const r = await setFilePublic(idToken, mountPath, file.path);
        setIsPublic(true); setUrl(r.publicUrl);
      }
    } catch (e: any) {
      alert(e.message ?? "Failed to update public sharing");
    } finally { setBusy(false); }
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this public link:", url);
    }
  };

  return (
    <span style={{ marginRight: 8 }}>
      <PublicButton isPublic={isPublic} busy={busy} copied={copied} onToggle={toggle} onCopy={copy} />
    </span>
  );
}

function Breadcrumbs({ mountPath, displayName, path }: { mountPath: string; displayName: string; path: string }) {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  const crumbs: { label: string; to: string }[] = [{ label: displayName, to: `/browse/${encodeURIComponent(mountPath)}` }];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    crumbs.push({ label: p, to: `/browse/${encodeURIComponent(mountPath)}?path=${encodeURIComponent(acc + "/")}` });
  }
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      {crumbs.map((c, i) => (
        <span key={i}>
          {i > 0 && <span className="muted"> / </span>}
          {i === crumbs.length - 1 ? <strong>{c.label}</strong> : <Link to={c.to}>{c.label}</Link>}
        </span>
      ))}
    </div>
  );
}

export default function Browse() {
  const { mountPath = "" } = useParams();
  const [search] = useSearchParams();
  const subpath = search.get("path") ?? "";
  const { idToken, isAdmin } = useAuth();
  const [displayName, setDisplayName] = useState<string>(mountPath);
  const [folders, setFolders] = useState<BrowseFolder[]>([]);
  const [files, setFiles] = useState<BrowseFile[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ url: string; name: string; kind: "video" | "audio" } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!idToken) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await browseList(idToken, mountPath, subpath);
      setDisplayName(r.mount.displayName);
      setFolders(r.folders);
      setFiles(r.files);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [idToken, mountPath, subpath]);

  useEffect(() => { load(); }, [load]);

  const download = async (filePath: string) => {
    if (!idToken) return;
    try {
      const { downloadUrl } = await getDownloadUrl(idToken, mountPath, filePath);
      window.location.assign(downloadUrl);
    } catch (e: any) {
      alert(e.message ?? "Download failed");
    }
  };

  const play = async (f: BrowseFile, kind: "video" | "audio") => {
    if (!idToken) return;
    try {
      const { downloadUrl, filename } = await getDownloadUrl(idToken, mountPath, f.path);
      setPlaying({ url: downloadUrl, name: filename ?? f.name, kind });
    } catch (e: any) {
      alert(e.message ?? "Couldn't open preview");
    }
  };

  const onFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files;
    if (!picked || !picked.length || !idToken) return;
    const list = Array.from(picked);
    e.target.value = ""; // allow re-selecting the same file later
    let done = 0;
    setUploadMsg(`Uploading 0/${list.length}…`);
    try {
      for (const file of list) {
        const rel = `${subpath}${file.name}`;
        const { uploadUrl } = await getUploadUrl(idToken, mountPath, rel);
        const res = await fetch(uploadUrl, { method: "PUT", body: file });
        if (!res.ok) throw new Error(`Upload failed for ${file.name} (HTTP ${res.status})`);
        done++;
        setUploadMsg(`Uploading ${done}/${list.length}…`);
      }
      setUploadMsg(`Uploaded ${done} file${done === 1 ? "" : "s"}.`);
      await load();
      setTimeout(() => setUploadMsg(null), 4000);
    } catch (err: any) {
      setUploadMsg(null);
      alert(err.message ?? "Upload failed");
      await load();
    }
  };

  const removeFile = async (file: BrowseFile) => {
    if (!idToken) return;
    if (!confirm(`Permanently delete "${file.name}"? This deletes the file from S3 and cannot be undone.`)) return;
    try {
      await deleteFile(idToken, mountPath, file.path);
      await load();
    } catch (e: any) {
      alert(e.message ?? "Delete failed");
    }
  };

  return (
    <div>
      <Breadcrumbs mountPath={mountPath} displayName={displayName} path={subpath} />
      {err && <p className="err">{err}</p>}
      {loading && <p className="muted">Loading…</p>}
      {uploadMsg && <p className="muted">{uploadMsg}</p>}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={onFilesSelected}
      />
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th style={{ width: 120 }}>Size</th>
            <th style={{ width: 180 }}>Modified</th>
            <th style={{ width: isAdmin ? 320 : 200 }}>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={{ background: "var(--success)", color: "#0b1f13" }}
              >
                Add file(s)
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {folders.map((f) => (
            <tr key={`d-${f.path}`}>
              <td>
                📁 <Link to={`/browse/${encodeURIComponent(mountPath)}?path=${encodeURIComponent(f.path)}`}>
                  {f.name}
                </Link>
              </td>
              <td className="muted">—</td>
              <td className="muted">—</td>
              <td></td>
            </tr>
          ))}
          {files.map((f) => {
            const cat = categoryFor(f.name);
            const playable = cat === "video" || cat === "audio";
            return (
            <tr key={`f-${f.path}`}>
              <td>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <FileThumb
                    category={cat}
                    name={f.name}
                    loadUrl={() => getDownloadUrl(idToken!, mountPath, f.path).then((r) => r.downloadUrl)}
                    onPlay={playable ? () => play(f, cat as "video" | "audio") : undefined}
                  />
                  <span>{f.name}</span>
                </div>
              </td>
              <td>{fmtBytes(f.size)}</td>
              <td className="muted">{f.lastModified ? new Date(f.lastModified).toLocaleDateString() : "—"}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                {isAdmin && <PublicCell mountPath={mountPath} file={f} />}
                {playable && (
                  <button type="button" onClick={() => play(f, cat as "video" | "audio")} style={{ marginRight: 8 }}>
                    ▶ Play
                  </button>
                )}
                <button onClick={() => download(f.path)}>Download</button>
                {isAdmin && (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => removeFile(f)}
                    title="Delete file"
                    aria-label={`Delete ${f.name}`}
                    style={{ marginLeft: 8, padding: "6px 8px", display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}
                  >
                    <TrashIcon />
                  </button>
                )}
              </td>
            </tr>
            );
          })}
          {!loading && !folders.length && !files.length && (
            <tr><td colSpan={4} className="muted" style={{ padding: "1rem" }}>Empty directory.</td></tr>
          )}
        </tbody>
      </table>
      {playing && (
        <MediaPlayer url={playing.url} name={playing.name} kind={playing.kind} onClose={() => setPlaying(null)} />
      )}
    </div>
  );
}
