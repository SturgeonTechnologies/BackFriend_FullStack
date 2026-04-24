import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export default function Callback() {
  const { handleCallback } = useAuth();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    handleCallback()
      .then((returnTo) => nav(returnTo || "/", { replace: true }))
      .catch((e) => setErr(e.message ?? "Sign-in failed"));
  }, [handleCallback, nav]);

  if (err) {
    return (
      <div className="card" style={{ maxWidth: 480, margin: "3rem auto" }}>
        <h2>Sign-in failed</h2>
        <p className="err">{err}</p>
        <p className="muted">
          If you were invited and just got here, the invite may have expired or been revoked.
          Ask your admin to re-send the invite, then try again.
        </p>
        <a href="/login">Back to sign in</a>
      </div>
    );
  }

  return <p style={{ padding: "2rem" }}>Finishing sign-in…</p>;
}
