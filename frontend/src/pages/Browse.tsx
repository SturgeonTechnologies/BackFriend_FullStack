import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { browseList, getDownloadUrl, BrowseFile, BrowseFolder } from "../lib/api";
import { useAuth } from "../lib/auth";

function fmtBytes(n: number) {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v > 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
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
  const { idToken } = useAuth();
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
            <th style={{ width: 120 }}></th>
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
              <td><button onClick={() => download(f.path)}>Download</button></td>
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
