import { useAuth } from "../lib/auth";

export default function Profile() {
  const { email, name, isAdmin, groups } = useAuth();

  return (
    <div>
      <h2>Profile</h2>
      <div className="card" style={{ maxWidth: 520 }}>
        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.5rem 1rem" }}>
          <dt className="muted">Name</dt>
          <dd style={{ margin: 0 }}>{name || <span className="muted">—</span>}</dd>

          <dt className="muted">Email</dt>
          <dd style={{ margin: 0 }}>{email || <span className="muted">—</span>}</dd>

          <dt className="muted">Role</dt>
          <dd style={{ margin: 0 }}>{isAdmin ? "Admin" : "Member"}</dd>

          {groups.length > 0 && (
            <>
              <dt className="muted">Groups</dt>
              <dd style={{ margin: 0 }}>{groups.join(", ")}</dd>
            </>
          )}
        </dl>
      </div>
      <p className="muted" style={{ marginTop: "1rem" }}>
        More profile settings will live here.
      </p>
    </div>
  );
}
