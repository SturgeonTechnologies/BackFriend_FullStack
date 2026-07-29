import { useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";

export default function Login() {
  const { loginWithGoogle, loginWithFacebook, loginWithEmail, idToken } = useAuth();
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
        Access is invite-only. Sign in with the email address your invite was sent to —
        use Google, Facebook, or an email + password.
      </p>
      <button onClick={() => loginWithGoogle(returnTo)} style={{ width: "100%" }}>
        Sign in with Google
      </button>

      <button
        onClick={() => loginWithFacebook(returnTo)}
        style={{ width: "100%", marginTop: "0.75rem" }}
      >
        Sign in with Facebook
      </button>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          margin: "1.25rem 0",
          color: "var(--muted, #888)",
          fontSize: 13,
        }}
      >
        <hr style={{ flex: 1, border: 0, borderTop: "1px solid #ccc" }} />
        or
        <hr style={{ flex: 1, border: 0, borderTop: "1px solid #ccc" }} />
      </div>

      <button
        className="secondary"
        onClick={() => loginWithEmail(returnTo)}
        style={{ width: "100%" }}
      >
        Sign in with email
      </button>
      <p className="muted" style={{ marginTop: "0.75rem", fontSize: 13 }}>
        First time with a password? Choose <strong>Sign in with email</strong>, then
        <strong> Sign up</strong> on the next screen. You'll get a one-time code to
        verify your address.
      </p>
      <p className="muted" style={{ marginTop: "1.25rem", fontSize: 12 }}>
        <a href="/privacy.html">Privacy Policy</a>
      </p>
    </div>
  );
}
