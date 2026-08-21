import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { listAccess, revokeInvite, AccessEntry } from "../lib/api";
import { useAuth } from "../lib/auth";

export default function AdminUserDetail() {
  const { idToken } = useAuth();
  const { email: encodedEmail } = useParams<{ email: string }>();
  const email = decodeURIComponent(encodedEmail ?? "");
  const [entry, setEntry] = useState<AccessEntry | null | undefined>(undefined); // undefined = loading
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!idToken) return;
    try {
      const { access } = await listAccess(idToken);
      setEntry(access.find((a) => a.email === email) ?? null);
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [idToken, email]);

  const handleRevoke = async () => {
    if (!idToken || !confirm(`Revoke invite for ${email}?`)) return;
    setBusy(true);
    try { await revokeInvite(idToken, email); await refresh(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <p><Link to="/admin">&larr; Back to Admin</Link></p>
      <h2 style={{ wordBreak: "break-all" }}>{email}</h2>
      <div className="card" style={{ maxWidth: 520 }}>
        {err && <p className="err">{err}</p>}
        {entry === undefined && !err && <p className="muted">Loading…</p>}
        {entry === null && !err && <p className="muted">No access record found for this email.</p>}
        {entry && (
          <>
            <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.5rem 1rem" }}>
              <dt className="muted">Role</dt>
              <dd style={{ margin: 0 }}>{entry.role === "admin" ? <strong>Admin</strong> : "Member"}</dd>

              <dt className="muted">Status</dt>
              <dd style={{ margin: 0 }}>{entry.status === "active" ? "Active" : "Invited (pending)"}</dd>

              <dt className="muted">Expires</dt>
              <dd style={{ margin: 0 }}>{entry.expiresAt ? new Date(entry.expiresAt).toLocaleDateString() : "—"}</dd>
            </dl>
            {entry.status === "pending" && (
              <button className="danger" disabled={busy} style={{ marginTop: "1rem" }} onClick={handleRevoke}>
                {busy ? "Revoking…" : "Revoke invite"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
