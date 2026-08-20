import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  browseList, getDownloadUrl, setFilePublic, unsetFilePublic,
  getUploadUrl, deleteFile, getMountAccess, updateMountAccess,
  BrowseFile, BrowseFolder,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { DownloadIcon, TrashIcon, UploadIcon } from "../lib/icons";
import { PublicButton } from "../lib/PublicButton";
import { FileThumb } from "../components/FileThumb";
import { MediaPlayer } from "../components/MediaPlayer";
import { ImageViewer } from "../components/ImageViewer";
import { DocViewer } from "../components/DocViewer";
import { EmailChips } from "../components/EmailChips";
import { categoryFor } from "../lib/fileTypes";
import { useDropUpload } from "../lib/useDropUpload";

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

/** Self-service allowed-emails editor for a mount's own admins (site admins,
 * or emails in the mount's mountAdmins list) -- lets them add/revoke viewer
 * access to this one directory without needing the full /admin page. */
function ManageAccessModal({ mountPath, displayName, onClose }: { mountPath: string; displayName: string; onClose: () => void }) {
  const { idToken } = useAuth();
  const [emails, setEmails] = useState<string[]>([]);
  const [mountAdmins, setMountAdmins] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!idToken) return;
    getMountAccess(idToken, mountPath)
      .then((r) => { setEmails(r.allowedEmails); setMountAdmins(r.mountAdmins); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [idToken, mountPath]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idToken) return;
    setSaving(true); setErr(null);
    try {
      await updateMountAccess(idToken, mountPath, emails.length ? emails : null);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally { setSaving(false); }
  };

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50,
      }}
    >
      <form
        onSubmit={save}
        onMouseDown={(e) => e.stopPropagation()}
        className="card"
        style={{ width: 460, maxWidth: "92vw", margin: 0 }}
      >
        <h3 style={{ marginTop: 0 }}>Manage access — {displayName}</h3>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <label>
              Allowed emails
              <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>
                — leave empty to restrict to admins only.
              </span>
            </label>
            <EmailChips emails={emails} onChange={setEmails} knownEmails={[]} />
            {mountAdmins.length > 0 && (
              <p className="muted" style={{ marginTop: "0.75rem", fontSize: 13 }}>
                Mount admins (can also manage this list): {mountAdmins.join(", ")}
              </p>
            )}
          </>
        )}
        {err && <p className="err">{err}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: "0.75rem" }}>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={loading || saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </form>
    </div>
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
  const [canManageAccess, setCanManageAccess] = useState(false);
  const [showManageAccess, setShowManageAccess] = useState(false);
  const [folders, setFolders] = useState<BrowseFolder[]>([]);
  const [files, setFiles] = useState<BrowseFile[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ url: string; name: string; kind: "video" | "audio" } | null>(null);
  const [viewingImage, setViewingImage] = useState<{ url: string; name: string } | null>(null);
  const [viewingDoc, setViewingDoc] = useState<{ kind: "pdf" | "text"; url: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!idToken) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await browseList(idToken, mountPath, subpath);
      setDisplayName(r.mount.displayName);
      setCanManageAccess(r.mount.canManageAccess);
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
      const { downloadUrl } = await getDownloadUrl(idToken, mountPath, filePath, true);
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

  const viewImage = async (f: BrowseFile) => {
    if (!idToken) return;
    try {
      const { downloadUrl, filename } = await getDownloadUrl(idToken, mountPath, f.path);
      setViewingImage({ url: downloadUrl, name: filename ?? f.name });
    } catch (e: any) {
      alert(e.message ?? "Couldn't open preview");
    }
  };

  const viewDoc = async (f: BrowseFile, kind: "pdf" | "text") => {
    if (!idToken) return;
    try {
      const { downloadUrl, filename } = await getDownloadUrl(idToken, mountPath, f.path);
      setViewingDoc({ kind, url: downloadUrl, name: filename ?? f.name });
    } catch (e: any) {
      alert(e.message ?? "Couldn't open preview");
    }
  };

  const uploadFiles = async (list: File[]) => {
    if (!idToken || !list.length) return;
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

  const onFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files;
    if (!picked || !picked.length) return;
    const list = Array.from(picked);
    e.target.value = ""; // allow re-selecting the same file later
    await uploadFiles(list);
  };

  // Drop target is whatever directory (mount + subpath) is currently open.
  const { isDragging, dropProps } = useDropUpload(uploadFiles);

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
    <div className="drop-zone-page" {...dropProps}>
      {isDragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-text">Drop to upload to {displayName}{subpath ? `/${subpath}` : ""}</div>
        </div>
      )}
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
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: "0.5rem" }}>
        {canManageAccess && (
          <button type="button" className="secondary" onClick={() => setShowManageAccess(true)}>
            Manage access
          </button>
        )}
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
        {folders.map((f) => (
          <div className="folder-row" key={`d-${f.path}`}>
            <span>📁</span>
            <Link className="folder-row-name" to={`/browse/${encodeURIComponent(mountPath)}?path=${encodeURIComponent(f.path)}`}>
              {f.name}
            </Link>
          </div>
        ))}
        {files.map((f) => {
          const cat = categoryFor(f.name);
          const playable = cat === "video" || cat === "audio";
          return (
            <div className="file-row" key={`f-${f.path}`}>
              <FileThumb
                category={cat}
                name={f.name}
                loadUrl={() => getDownloadUrl(idToken!, mountPath, f.path).then((r) => r.downloadUrl)}
                onPlay={playable ? () => play(f, cat as "video" | "audio") : undefined}
                onOpen={
                  cat === "image" ? () => viewImage(f)
                  : cat === "pdf" || cat === "text" ? () => viewDoc(f, cat)
                  : undefined
                }
              />
              <div className="file-row-main">
                <div className="file-row-top">
                  <span className="file-row-name" title={f.name}>{f.name}</span>
                  <span className="file-row-size muted">{fmtBytes(f.size)}</span>
                </div>
                <div className="file-row-bottom">
                  <span className="muted">{f.lastModified ? new Date(f.lastModified).toLocaleDateString() : "—"}</span>
                  {isAdmin && <PublicCell mountPath={mountPath} file={f} />}
                  <button
                    type="button"
                    onClick={() => download(f.path)}
                    title="Download"
                    aria-label={`Download ${f.name}`}
                    style={{ padding: "6px 8px", display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}
                  >
                    <DownloadIcon />
                  </button>
                  {isAdmin && (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => removeFile(f)}
                      title="Delete file"
                      aria-label={`Delete ${f.name}`}
                      style={{ padding: "6px 8px", display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {!loading && !folders.length && !files.length && (
          <p className="muted" style={{ padding: "1rem 0" }}>Empty directory.</p>
        )}
      </div>
      {playing && (
        <MediaPlayer url={playing.url} name={playing.name} kind={playing.kind} onClose={() => setPlaying(null)} />
      )}
      {viewingImage && (
        <ImageViewer url={viewingImage.url} name={viewingImage.name} onClose={() => setViewingImage(null)} />
      )}
      {viewingDoc && (
        <DocViewer kind={viewingDoc.kind} url={viewingDoc.url} name={viewingDoc.name} onClose={() => setViewingDoc(null)} />
      )}
      {showManageAccess && (
        <ManageAccessModal mountPath={mountPath} displayName={displayName} onClose={() => setShowManageAccess(false)} />
      )}
    </div>
  );
}
