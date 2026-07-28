import { useEffect, useRef, useState } from "react";
import { Routes, Route, Navigate, Link } from "react-router-dom";
import { useAuth } from "./lib/auth";
import Login from "./pages/Login";
import Callback from "./pages/Callback";
import Home from "./pages/Home";
import Browse from "./pages/Browse";
import Admin from "./pages/Admin";
import Profile from "./pages/Profile";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { idToken, loading } = useAuth();
  if (loading) return <p style={{ padding: "2rem" }}>Loading…</p>;
  if (!idToken) return <Navigate to={`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`} replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { idToken, isAdmin, loading } = useAuth();
  if (loading) return <p style={{ padding: "2rem" }}>Loading…</p>;
  if (!idToken) return <Navigate to="/login" replace />;
  if (!isAdmin) return <p style={{ padding: "2rem" }}>Admin access required.</p>;
  return <>{children}</>;
}

function HouseIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8.707 1.5a1 1 0 0 0-1.414 0L.646 8.146a.5.5 0 0 0 .708.708L2 8.207V13.5A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V8.207l.646.647a.5.5 0 0 0 .708-.708L13 5.793V2.5a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v1.293zM13 7.207V13.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V7.207l5-5 5 5z" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
      <path fillRule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708" />
    </svg>
  );
}

function UserMenu() {
  const { email, name, isAdmin, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button className="user-menu-trigger" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <span className="muted">{name || email}</span>
        <ChevronDown />
      </button>
      {open && (
        <div className="user-menu-panel" role="menu">
          {isAdmin && <Link role="menuitem" to="/admin" onClick={() => setOpen(false)}>Admin</Link>}
          <Link role="menuitem" to="/profile" onClick={() => setOpen(false)}>Profile</Link>
          <button role="menuitem" onClick={() => { setOpen(false); logout(); }}>Log out</button>
        </div>
      )}
    </div>
  );
}

function Nav() {
  const { email, idToken } = useAuth();
  return (
    <nav>
      {idToken && (
        <Link to="/" title="Home" aria-label="Home" className="nav-icon">
          <HouseIcon />
        </Link>
      )}
      <div className="spacer" />
      {email ? <UserMenu /> : <Link to="/login">Log in</Link>}
    </nav>
  );
}

export default function App() {
  return (
    <>
      <Nav />
      <main>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/callback" element={<Callback />} />
          <Route path="/" element={<RequireAuth><Home /></RequireAuth>} />
          <Route path="/browse/:mountPath" element={<RequireAuth><Browse /></RequireAuth>} />
          <Route path="/profile" element={<RequireAuth><Profile /></RequireAuth>} />
          <Route path="/admin" element={<RequireAdmin><Admin /></RequireAdmin>} />
          <Route path="*" element={<p>Not found.</p>} />
        </Routes>
      </main>
    </>
  );
}
