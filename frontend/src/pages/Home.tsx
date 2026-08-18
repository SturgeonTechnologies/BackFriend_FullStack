import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listMounts, searchFiles, getDownloadUrl, Mount, SearchResult } from "../lib/api";
import { useAuth } from "../lib/auth";
import { FileThumb } from "../components/FileThumb";
import { MediaPlayer } from "../components/MediaPlayer";
import { categoryFor } from "../lib/fileTypes";

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

  // Global search.
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ url: string; name: string; kind: "video" | "audio" } | null>(null);

  useEffect(() => {
    if (!idToken) return;
    listMounts(idToken)
      .then((r) => setMounts(r.mounts))
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
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
      const { downloadUrl } = await getDownloadUrl(idToken, mountPath, path);
      window.location.assign(downloadUrl);
    } catch (e: any) { alert(e.message ?? "Download failed"); }
  };

  const play = async (f: SearchResult, kind: "video" | "audio") => {
    if (!idToken) return;
    try {
      const { downloadUrl, filename } = await getDownloadUrl(idToken, f.mountPath, f.path);
      setPlaying({ url: downloadUrl, name: filename ?? f.name, kind });
    } catch (e: any) { alert(e.message ?? "Couldn't open preview"); }
  };

  return (
    <div>
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
                          <button onClick={() => download(f.mountPath, f.path)}>Download</button>
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
    </div>
  );
}
