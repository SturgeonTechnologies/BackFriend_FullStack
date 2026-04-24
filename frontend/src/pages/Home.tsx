import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listMounts, Mount } from "../lib/api";
import { useAuth } from "../lib/auth";

export default function Home() {
  const { idToken } = useAuth();
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!idToken) return;
    listMounts(idToken)
      .then((r) => setMounts(r.mounts))
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [idToken]);

  return (
    <div>
      <h2>Shared directories</h2>
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
    </div>
  );
}
