import { useState } from "react";
import { TrashIcon } from "../lib/icons";

// Allowed-emails editor: an input with autocomplete (from a known-emails
// list, e.g. active users + pending invites) plus Enter-to-add; added emails
// render as chips with a trash icon to remove. Value is the list of emails.
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export function EmailChips({
  emails, onChange, knownEmails,
}: {
  emails: string[];
  onChange: (next: string[]) => void;
  /** Emails to suggest while typing (e.g. site-wide known users). Pass [] for none. */
  knownEmails: string[];
}) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);

  const add = (raw: string) => {
    const e = raw.trim().toLowerCase();
    if (!e || !isEmail(e) || emails.includes(e)) return;
    onChange([...emails, e]);
    setDraft("");
  };
  const remove = (e: string) => onChange(emails.filter((x) => x !== e));
  const suggestions = (): string[] => {
    const d = draft.trim().toLowerCase();
    return knownEmails.filter((e) => !emails.includes(e) && (d === "" || e.includes(d))).slice(0, 8);
  };

  return (
    <div>
      <div style={{ position: "relative" }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(draft); } }}
          placeholder="type or pick an email to add"
          autoComplete="off"
        />
        {focused && suggestions().length > 0 && (
          <div className="autocomplete-panel">
            {suggestions().map((e) => (
              <div key={e} className="autocomplete-item" onMouseDown={(ev) => { ev.preventDefault(); add(e); }}>
                {e}
              </div>
            ))}
          </div>
        )}
      </div>
      {emails.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {emails.map((e) => (
            <span key={e} className="email-chip">
              {e}
              <button
                type="button"
                className="email-chip-remove"
                onClick={() => remove(e)}
                title={`Remove ${e}`}
                aria-label={`Remove ${e}`}
              >
                <TrashIcon />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
