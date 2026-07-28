import { useEffect, useRef, useState } from "react";
import {
  createInvite, revokeInvite, listAccess, AccessEntry,
  createMount, deleteMount, listMounts, Mount,
  exploreBucket, createFolder, ExploreResult, ExploreFile,
  exploreDownloadUrl, exploreDeleteFile, exploreSetPublic, exploreUnsetPublic,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { TrashIcon } from "../lib/icons";
import { PublicButton } from "../lib/PublicButton";

export default function Admin() {
  return (
    <div>
      <h2>Admin</h2>
      <InvitesCard />
      <MountsCard />
    </div>
  );
}

interface InviteResultBanner {
  kind: "success" | "warning";
  email: string;
  signupUrl: string;
  emailError?: string;
}

function InvitesCard() {
  const { idToken } = useAuth();
  const [access, setAccess] = useState<AccessEntry[]>([]);
  const [email, setEmail] = useState("");
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [ttlDays, setTtlDays] = useState(14);
  const [sendEmail, setSendEmail] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Banner showing whether the invite email actually went out. Persists
  // until the next create or until the admin dismisses it, so admins can
  // copy `signupUrl` if SES rejected the send (sandbox / unverified
  // recipient / DKIM still pending).
  const [result, setResult] = useState<InviteResultBanner | null>(null);

  const refresh = async () => {
    if (!idToken) return;
    try { setAccess((await listAccess(idToken)).access); }
    catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idToken) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const res = await createInvite(idToken, {
        email: email.trim().toLowerCase(),
        groups: makeAdmin ? ["admins"] : [],
        ttlDays,
        sendEmail,
      });
      setResult({
        kind: res.emailSent || !sendEmail ? "success" : "warning",
        email: res.email,
        signupUrl: res.signupUrl,
        emailError: res.emailError,
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
            <div style={{ maxWidth: 200 }}>
              <label><input type="checkbox" checked={makeAdmin} onChange={(e) => setMakeAdmin(e.target.checked)} /> Make admin</label>
              <label style={{ display: "block", marginTop: 4 }}>
                <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} /> Send invite email
              </label>
              <button disabled={busy} style={{ marginTop: 8 }}>
                {busy ? "Creating…" : "Create invite"}
              </button>
            </div>
          </div>
        </form>
        {result && (
          <div
            className={result.kind === "success" ? "banner-ok" : "banner-warn"}
            style={{
              marginTop: "0.75rem",
              padding: "0.75rem",
              border: "1px solid",
              borderColor: result.kind === "success" ? "#1f6feb" : "#b58900",
              background: result.kind === "success" ? "#f0f6ff" : "#fff8e1",
              borderRadius: 6,
              fontSize: 14,
            }}
          >
            {result.kind === "success" && sendEmail && (
              <div>Invite created and email sent to <strong>{result.email}</strong>.</div>
            )}
            {result.kind === "success" && !sendEmail && (
              <>
                <div>Invite created for <strong>{result.email}</strong> (no email sent).</div>
                <div style={{ marginTop: 4 }}>
                  Share this link manually:{" "}
                  <code style={{ wordBreak: "break-all" }}>{result.signupUrl}</code>
                </div>
              </>
            )}
            {result.kind === "warning" && (
              <>
                <div>
                  Invite created for <strong>{result.email}</strong>, but the email failed to send.
                </div>
                {result.emailError && (
                  <div style={{ marginTop: 4, fontSize: 13, color: "#7a5a00" }}>
                    SES error: <code>{result.emailError}</code>
                  </div>
                )}
                <div style={{ marginTop: 4 }}>
                  Share this link manually:{" "}
                  <code style={{ wordBreak: "break-all" }}>{result.signupUrl}</code>
                </div>
              </>
            )}
            <button
              type="button"
              onClick={() => setResult(null)}
              style={{ marginTop: 8 }}
            >
              Dismiss
            </button>
          </div>
        )}
        {err && <p className="err">{err}</p>}
      </div>

      <div className="card">
        <h3>Invites/Access</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Everyone who can sign in (including admins), plus invites that haven't been used yet.
        </p>
        <table>
          <thead><tr>
            <th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th></th>
          </tr></thead>
          <tbody>
            {access.map((a) => (
              <tr key={a.email}>
                <td>{a.email}</td>
                <td>{a.role === "admin" ? <strong>Admin</strong> : "Member"}</td>
                <td className="muted">{a.status === "active" ? "Active" : "Invited (pending)"}</td>
                <td className="muted">{a.expiresAt ? new Date(a.expiresAt).toLocaleDateString() : "—"}</td>
                <td>
                  {a.status === "pending" && (
                    <button className="danger" onClick={() => handleRevoke(a.email)}>Revoke</button>
                  )}
                </td>
              </tr>
            ))}
            {!access.length && <tr><td colSpan={5} className="muted">No one has access yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// Turn an S3 folder leaf into a valid mount path: lowercase, non-[a-z0-9_-]
// runs → "-", must start with an alphanumeric, max 32 chars (matches the
// server's ^[a-z0-9][a-z0-9_-]{0,31}$).
function sanitizeMountPath(leaf: string): string {
  return leaf
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32);
}

// Humanize a folder leaf into a default display name (separators → spaces,
// first letter capitalized). Admins can edit before saving.
function humanizeName(leaf: string): string {
  const t = leaf.replace(/[_-]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

// Parent of an S3 prefix: "Video/Movies/" → "Video/", "Video/" → "".
function parentPrefix(p: string): string {
  const t = p.replace(/\/$/, "");
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(0, i + 1) : "";
}

// Public / Download / Delete controls for a file in the bucket explorer,
// addressed by full S3 key (admin-only). Mirrors Browse.tsx's PublicCell.
function ExplorerFileActions({ file, onDeleted }: { file: ExploreFile; onDeleted: () => void }) {
  const { idToken } = useAuth();
  const [isPublic, setIsPublic] = useState(!!file.public);
  const [url, setUrl] = useState<string | undefined>(file.publicUrl);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const togglePublic = async () => {
    if (!idToken || busy) return;
    setBusy(true);
    try {
      if (isPublic) { await exploreUnsetPublic(idToken, file.path); setIsPublic(false); setUrl(undefined); }
      else { const r = await exploreSetPublic(idToken, file.path); setIsPublic(true); setUrl(r.publicUrl); }
    } catch (e: any) { alert(e.message ?? "Failed to update public sharing"); }
    finally { setBusy(false); }
  };

  const copy = async () => {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { window.prompt("Copy this public link:", url); }
  };

  const download = async () => {
    if (!idToken) return;
    try { const { downloadUrl } = await exploreDownloadUrl(idToken, file.path); window.location.assign(downloadUrl); }
    catch (e: any) { alert(e.message ?? "Download failed"); }
  };

  const remove = async () => {
    if (!idToken) return;
    if (!confirm(`Permanently delete "${file.name}"? This deletes the file from S3 and cannot be undone.`)) return;
    try { await exploreDeleteFile(idToken, file.path); onDeleted(); }
    catch (e: any) { alert(e.message ?? "Delete failed"); }
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
      <PublicButton isPublic={isPublic} busy={busy} copied={copied} onToggle={togglePublic} onCopy={copy} />
      <button type="button" onClick={download}>Download</button>
      <button type="button" className="danger" onClick={remove} title="Delete file" aria-label={`Delete ${file.name}`}
        style={{ padding: "6px 8px", display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}>
        <TrashIcon />
      </button>
    </span>
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

  // Bucket explorer state.
  const [exp, setExp] = useState<ExploreResult | null>(null);
  const [expPrefix, setExpPrefix] = useState("");
  const [expErr, setExpErr] = useState<string | null>(null);
  const [expLoading, setExpLoading] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // "Create directory" popup state.
  const [showNewDir, setShowNewDir] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [creatingDir, setCreatingDir] = useState(false);

  // Known emails (invites + active users) for the Allowed-emails autocomplete.
  const [knownEmails, setKnownEmails] = useState<string[]>([]);
  const [emailFocused, setEmailFocused] = useState(false);

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

  const loadExplore = async (p: string) => {
    if (!idToken) return;
    setExpLoading(true); setExpErr(null);
    try {
      const r = await exploreBucket(idToken, p);
      setExp(r);
      setExpPrefix(r.prefix);
    } catch (e: any) { setExpErr(e.message); }
    finally { setExpLoading(false); }
  };

  const handleCreateDir = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idToken) return;
    const name = newDirName.trim();
    if (!name) return;
    setCreatingDir(true); setExpErr(null);
    try {
      await createFolder(idToken, expPrefix, name);
      setShowNewDir(false);
      setNewDirName("");
      await loadExplore(expPrefix); // refresh so the new folder shows up
    } catch (e: any) { setExpErr(e.message); }
    finally { setCreatingDir(false); }
  };

  // Fill the add-mount form from a discovered directory, then scroll to it so
  // the admin can review/adjust access before submitting.
  const useDirectory = (fullKey: string) => {
    const leaf = fullKey.replace(/\/$/, "").split("/").pop() || "";
    setPrefix(fullKey);
    setMountPath(sanitizeMountPath(leaf));
    setDisplayName(humanizeName(leaf));
    setBucket("");
    setErr(null);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  useEffect(() => {
    refresh();
    loadExplore("");
    if (idToken) listAccess(idToken).then((r) => setKnownEmails(r.access.map((a) => a.email))).catch(() => {});
    /* eslint-disable-next-line */
  }, []);

  // Autocomplete for the comma-separated Allowed-emails field: suggest known
  // emails matching the token after the last comma, excluding ones already added.
  const emailToken = () => allowedEmailsRaw.slice(allowedEmailsRaw.lastIndexOf(",") + 1).trim().toLowerCase();
  const emailSuggestions = (): string[] => {
    const entered = new Set(parseEmails(allowedEmailsRaw));
    const tok = emailToken();
    return knownEmails
      .filter((e) => !entered.has(e) && (tok === "" || e.toLowerCase().includes(tok)))
      .slice(0, 8);
  };
  const pickEmail = (email: string) => {
    const i = allowedEmailsRaw.lastIndexOf(",");
    const prefix = i >= 0 ? allowedEmailsRaw.slice(0, i + 1) + " " : "";
    setAllowedEmailsRaw(prefix + email + ", ");
  };

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
    if (!confirm(`Remove mount "${mp}"? This only removes the share — the files in S3 are not deleted.`)) return;
    try { await deleteMount(idToken, mp); await refresh(); }
    catch (e: any) { setErr(e.message); }
  };

  const linkBtn: React.CSSProperties = {
    background: "none", border: "none", color: "var(--accent)",
    cursor: "pointer", padding: 0, font: "inherit", textAlign: "left",
  };

  return (
    <>
      <div className="card">
        <h3>Explore bucket</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Browse the real S3 layout and turn any directory into a mount.
          <strong> Use this directory</strong> fills the form below — review it, then
          click <strong>Add mount</strong>.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
          <button type="button" className="secondary" disabled={!expPrefix || expLoading} onClick={() => loadExplore("")}>
            Root
          </button>
          <button type="button" className="secondary" disabled={!expPrefix || expLoading} onClick={() => loadExplore(parentPrefix(expPrefix))}>
            Up
          </button>
          <code>/{expPrefix}</code>
          {expLoading && <span className="muted">Loading…</span>}
        </div>
        {expErr && <p className="err">{expErr}</p>}

        {showNewDir && (
          <div
            onMouseDown={() => setShowNewDir(false)}
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
              display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50,
            }}
          >
            <form
              onSubmit={handleCreateDir}
              onMouseDown={(e) => e.stopPropagation()}
              className="card"
              style={{ width: 360, maxWidth: "90vw", margin: 0 }}
            >
              <h3 style={{ marginTop: 0 }}>Create directory</h3>
              <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
                New folder in <code>/{expPrefix}</code>
              </p>
              <input
                autoFocus
                value={newDirName}
                onChange={(e) => setNewDirName(e.target.value)}
                placeholder="folder name"
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: "0.75rem" }}>
                <button type="button" className="secondary" onClick={() => setShowNewDir(false)}>Cancel</button>
                <button
                  type="submit"
                  disabled={creatingDir || !newDirName.trim()}
                  style={{ background: "var(--success)", color: "#0b1f13" }}
                >
                  {creatingDir ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          </div>
        )}
        <table>
          <thead><tr>
            <th>Name</th><th>Type</th><th>Size</th>
            <th>
              <button
                type="button"
                onClick={() => { setNewDirName(""); setExpErr(null); setShowNewDir(true); }}
                style={{ background: "var(--success)", color: "#0b1f13" }}
              >
                Create Directory
              </button>
            </th>
          </tr></thead>
          <tbody>
            {exp?.folders.map((f) => (
              <tr key={f.path}>
                <td>
                  <button type="button" style={linkBtn} onClick={() => loadExplore(f.path)}>
                    📁 {f.name}/
                  </button>
                </td>
                <td className="muted">folder</td>
                <td className="muted">—</td>
                <td>
                  <button type="button" onClick={() => useDirectory(f.path)}>Use this directory</button>
                </td>
              </tr>
            ))}
            {exp?.files.map((f) => (
              <tr key={f.path}>
                <td className="muted">📄 {f.name}</td>
                <td className="muted">file</td>
                <td className="muted">{formatSize(f.size)}</td>
                <td><ExplorerFileActions file={f} onDeleted={() => loadExplore(expPrefix)} /></td>
              </tr>
            ))}
            {exp && !exp.folders.length && !exp.files.length && (
              <tr><td colSpan={4} className="muted">This directory is empty.</td></tr>
            )}
            {!exp && !expErr && (
              <tr><td colSpan={4} className="muted">Loading…</td></tr>
            )}
          </tbody>
        </table>
        {exp?.truncated && (
          <p className="muted" style={{ marginTop: 4 }}>Listing truncated at 1000 items.</p>
        )}
        {expPrefix && (
          <button type="button" style={{ marginTop: 8 }} onClick={() => useDirectory(expPrefix)}>
            Use current directory (<code>/{expPrefix}</code>)
          </button>
        )}
      </div>

      <div className="card">
        <h3>Add a shared directory (mount)</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Maps a URL path like <code>/roms</code> to an S3 prefix. Bucket defaults to the stack's configured shares bucket.
        </p>
        <form ref={formRef} onSubmit={handleCreate}>
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
                — leave blank to restrict to admins only. Admins always see every mount.
              </span>
            </label>
            <div style={{ position: "relative" }}>
              <input
                value={allowedEmailsRaw}
                onChange={(e) => setAllowedEmailsRaw(e.target.value)}
                onFocus={() => setEmailFocused(true)}
                onBlur={() => setEmailFocused(false)}
                placeholder="start typing — pick from invited / active users"
                autoComplete="off"
              />
              {emailFocused && emailSuggestions().length > 0 && (
                <div className="autocomplete-panel">
                  {emailSuggestions().map((e) => (
                    <div
                      key={e}
                      className="autocomplete-item"
                      onMouseDown={(ev) => { ev.preventDefault(); pickEmail(e); }}
                    >
                      {e}
                    </div>
                  ))}
                </div>
              )}
            </div>
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
                    : "admins only"}
                </td>
                <td><button className="danger" onClick={() => handleDelete(m.mountPath)}>Remove mount</button></td>
              </tr>
            ))}
            {!mounts.length && <tr><td colSpan={5} className="muted">No mounts yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
