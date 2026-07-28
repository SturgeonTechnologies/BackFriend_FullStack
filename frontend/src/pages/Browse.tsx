import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  browseList, getDownloadUrl, setFilePublic, unsetFilePublic,
  BrowseFile, BrowseFolder,
} from "../lib/api";
import { useAuth } from "../lib/auth";

function fmtBytes(n: number) {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v > 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

const YELLOW = "#e3b341";

function ClipboardIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1z" />
      <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0z" />
    </svg>
  );
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
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 8 }}>
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        title={isPublic ? "Public — click to make private" : "Make this file public"}
        style={{
          background: isPublic ? YELLOW : "transparent",
          color: isPublic ? "#1a1d23" : YELLOW,
          border: `1px solid ${YELLOW}`,
          padding: "4px 10px",
          borderRadius: 6,
          fontWeight: 600,
          cursor: busy ? "default" : "pointer",
        }}
      >
        Public
      </button>
      {isPublic && (
        <button
          type="button"
          onClick={copy}
          title="Copy public link"
          aria-label="Copy public link"
          style={{
            background: "transparent", border: "none", color: YELLOW,
            cursor: "pointer", padding: 2, display: "inline-flex", alignItems: "center",
          }}
        >
          {copied ? <span style={{ fontSize: 12 }}>Copied!</span> : <ClipboardIcon />}
        </button>
      )}
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

  useEffect(() => {
    if (!idToken) return;
    setLoading(true);
    setErr(null);
    browseList(idToken, mountPath, subpath)
      .then((r) => {
        setDisplayName(r.mount.displayName);
        setFolders(r.folders);
        setFiles(r.files);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [idToken, mountPath, subpath]);

  const download = async (filePath: string) => {
    if (!idToken) return;
    try {
      const { downloadUrl } = await getDownloadUrl(idToken, mountPath, filePath);
      window.location.assign(downloadUrl);
    } catch (e: any) {
      alert(e.message ?? "Download failed");
    }
  };

  return (
    <div>
      <Breadcrumbs mountPath={mountPath} displayName={displayName} path={subpath} />
      {err && <p className="err">{err}</p>}
      {loading && <p className="muted">Loading…</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th style={{ width: 120 }}>Size</th>
            <th style={{ width: 180 }}>Modified</th>
            <th style={{ width: isAdmin ? 260 : 120 }}></th>
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
          {files.map((f) => (
            <tr key={`f-${f.path}`}>
              <td>📄 {f.name}</td>
              <td>{fmtBytes(f.size)}</td>
              <td className="muted">{f.lastModified ? new Date(f.lastModified).toLocaleDateString() : "—"}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                {isAdmin && <PublicCell mountPath={mountPath} file={f} />}
                <button onClick={() => download(f.path)}>Download</button>
              </td>
            </tr>
          ))}
          {!loading && !folders.length && !files.length && (
            <tr><td colSpan={4} className="muted" style={{ padding: "1rem" }}>Empty directory.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
