import { Routes, Route, Navigate, Link } from "react-router-dom";
import { useAuth } from "./lib/auth";
import Login from "./pages/Login";
import Callback from "./pages/Callback";
import Home from "./pages/Home";
import Browse from "./pages/Browse";
import Admin from "./pages/Admin";

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

function Nav() {
  const { email, name, isAdmin, logout, idToken } = useAuth();
  return (
    <nav>
      <Link to="/"><strong>sharing.schuit.io</strong></Link>
      {idToken && <Link to="/">Home</Link>}
      {isAdmin && <Link to="/admin">Admin</Link>}
      <div className="spacer" />
      {email ? (
        <>
          <span className="muted">{name || email}</span>
          <button className="secondary" onClick={logout}>Log out</button>
        </>
      ) : (
        <Link to="/login">Log in</Link>
      )}
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
          <Route path="/admin" element={<RequireAdmin><Admin /></RequireAdmin>} />
          <Route path="*" element={<p>Not found.</p>} />
        </Routes>
      </main>
    </>
  );
}
