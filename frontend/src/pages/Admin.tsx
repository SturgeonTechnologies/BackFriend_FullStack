import { useEffect, useState } from "react";
import {
  listInvites, createInvite, revokeInvite, Invite,
  createMount, deleteMount, listMounts, Mount,
} from "../lib/api";
import { useAuth } from "../lib/auth";

export default function Admin() {
  return (
    <div>
      <h2>Admin</h2>
      <InvitesCard />
      <MountsCard />
    </div>
  );
}

function InvitesCard() {
  const { idToken } = useAuth();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [ttlDays, setTtlDays] = useState(14);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    if (!idToken) return;
    try { setInvites((await listInvites(idToken)).invites); }
    catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idToken) return;
    setBusy(true); setErr(null);
    try {
      await createInvite(idToken, {
        email: email.trim().toLowerCase(),
        groups: makeAdmin ? ["admins"] : [],
        ttlDays,
      });
      setEmail(""); setMakeAdmin(false);
      await refresh();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const handleRevoke = async (em: string) => {
    if (!idToken) return;
    if (!confirm(`Revoke invite for ${em}?`)) return;
    try { await revokeInvite(idToken, em); await refresh(); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <div className="card">
        <h3>Invite a user</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          The invitee goes to <code>sharing.schuit.io</code>, clicks "Sign in with Google", and is let in automatically.
        </p>
        <form onSubmit={handleCreate}>
          <div className="row">
            <div>
              <label>Email (must match the Google account they'll use)</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div style={{ maxWidth: 120 }}>
              <label>Expires (days)</label>
              <input type="number" min={1} max={90} value={ttlDays} onChange={(e) => setTtlDays(Number(e.target.value))} />
            </div>
            <div style={{ maxWidth: 160 }}>
              <label><input type="checkbox" checked={makeAdmin} onChange={(e) => setMakeAdmin(e.target.checked)} /> Make admin</label>
              <button disabled={busy} style={{ marginTop: 8 }}>
                {busy ? "Creating…" : "Create invite"}
              </button>
            </div>
          </div>
        </form>
        {err && <p className="err">{err}</p>}
      </div>

      <div className="card">
        <h3>Invites</h3>
        <table>
          <thead><tr>
            <th>Email</th><th>Groups</th><th>Created</th><th>Expires</th><th>Redeemed</th><th></th>
          </tr></thead>
          <tbody>
            {invites.map((i) => (
              <tr key={i.email}>
                <td>{i.email}</td>
                <td>{i.groups.join(", ") || "—"}</td>
                <td>{new Date(i.createdAt).toLocaleString()}</td>
                <td>{new Date(i.expiresAt).toLocaleString()}</td>
                <td>{i.redeemedAt ? new Date(i.redeemedAt).toLocaleString() : "—"}</td>
                <td>
                  {!i.redeemedAt && <button className="danger" onClick={() => handleRevoke(i.email)}>Revoke</button>}
                </td>
              </tr>
            ))}
            {!invites.length && <tr><td colSpan={6} className="muted">No invites yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function MountsCard() {
  const { idToken } = useAuth();
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [mountPath, setMountPath] = useState("roms");
  const [displayName, setDisplayName] = useState("Video Game ROMs");
  const [prefix, setPrefix] = useState("Video_Game_ROMs/");
  const [bucket, setBucket] = useState("");
  const [description, setDescription] = useState("");
  const [allowedEmailsRaw, setAllowedEmailsRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const parseEmails = (raw: string): string[] =>
    raw
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);

  const refresh = async () => {
    if (!idToken) return;
    try { setMounts((await listMounts(idToken)).mounts); }
    catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idToken) return;
    setBusy(true); setErr(null);
    try {
      const emails = parseEmails(allowedEmailsRaw);
      await createMount(idToken, {
        mountPath: mountPath.trim(),
        displayName: displayName.trim(),
        prefix: prefix.trim(),
        description: description.trim() || undefined,
        bucket: bucket.trim() || undefined,
        allowedEmails: emails.length ? emails : undefined,
      });
      setAllowedEmailsRaw("");
      await refresh();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const handleDelete = async (mp: string) => {
    if (!idToken) return;
    if (!confirm(`Delete mount "${mp}"? (Files in S3 are not touched.)`)) return;
    try { await deleteMount(idToken, mp); await refresh(); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <div className="card">
        <h3>Add a shared directory (mount)</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Maps a URL path like <code>/roms</code> to an S3 prefix. Bucket defaults to the stack's configured shares bucket.
        </p>
        <form onSubmit={handleCreate}>
          <div className="row">
            <div style={{ maxWidth: 140 }}>
              <label>Path</label>
              <input value={mountPath} onChange={(e) => setMountPath(e.target.value)} placeholder="roms" required />
            </div>
            <div>
              <label>Display name</label>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </div>
          </div>
          <div className="row" style={{ marginTop: "0.75rem" }}>
            <div>
              <label>S3 prefix</label>
              <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="Video_Game_ROMs/" required />
            </div>
            <div>
              <label>Bucket (optional)</label>
              <input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="schuit-sharing" />
            </div>
          </div>
          <div style={{ marginTop: "0.75rem" }}>
            <label>Description (optional)</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div style={{ marginTop: "0.75rem" }}>
            <label>
              Allowed emails (optional, comma-separated)
              <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>
                — leave blank to share with all signed-in users. Admins always see every mount.
              </span>
            </label>
            <input
              value={allowedEmailsRaw}
              onChange={(e) => setAllowedEmailsRaw(e.target.value)}
              placeholder="alice@example.com, bob@example.com"
            />
          </div>
          <button disabled={busy} style={{ marginTop: "0.75rem" }}>
            {busy ? "Adding…" : "Add mount"}
          </button>
        </form>
        {err && <p className="err">{err}</p>}
      </div>

      <div className="card">
        <h3>Mounts</h3>
        <table>
          <thead><tr>
            <th>Path</th><th>Display name</th><th>Description</th><th>Shared with</th><th></th>
          </tr></thead>
          <tbody>
            {mounts.map((m) => (
              <tr key={m.mountPath}>
                <td><code>/{m.mountPath}</code></td>
                <td>{m.displayName}</td>
                <td className="muted">{m.description || "—"}</td>
                <td className="muted">
                  {m.allowedEmails && m.allowedEmails.length
                    ? m.allowedEmails.join(", ")
                    : "everyone"}
                </td>
                <td><button className="danger" onClick={() => handleDelete(m.mountPath)}>Delete</button></td>
              </tr>
            ))}
            {!mounts.length && <tr><td colSpan={5} className="muted">No mounts yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
