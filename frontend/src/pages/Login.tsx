import { useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";

export default function Login() {
  const { loginWithGoogle, idToken } = useAuth();
  const [params] = useSearchParams();
  const returnTo = params.get("returnTo") ?? "/";

  if (idToken) {
    window.location.replace(returnTo);
    return null;
  }

  return (
    <div className="card" style={{ maxWidth: 440, margin: "3rem auto", textAlign: "center" }}>
      <h2>Welcome</h2>
      <p className="muted" style={{ marginBottom: "1.5rem" }}>
        Access is invite-only. Sign in with the Google account your invite was sent to.
      </p>
      <button onClick={() => loginWithGoogle(returnTo)} style={{ width: "100%" }}>
        Sign in with Google
      </button>
    </div>
  );
}
