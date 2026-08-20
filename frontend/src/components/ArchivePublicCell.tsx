import { useState } from "react";
import { setArchivePublic, unsetArchivePublic, ArchiveFile } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PublicButton } from "../lib/PublicButton";

/** Personal-archive equivalent of Browse.tsx's PublicCell -- same share
 * icon toggle, just backed by /archive/public instead of the mount-based
 * setFilePublic/unsetFilePublic. */
export function ArchivePublicCell({ file }: { file: ArchiveFile }) {
  const { idToken } = useAuth();
  const [isPublic, setIsPublic] = useState(!!file.public);
  const [url, setUrl] = useState<string | undefined>(file.publicUrl);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const toggle = async () => {
    if (!idToken || busy) return;
    setBusy(true);
    try {
      if (isPublic) {
        await unsetArchivePublic(idToken, file.key);
        setIsPublic(false); setUrl(undefined);
      } else {
        const r = await setArchivePublic(idToken, file.key);
        setIsPublic(true); setUrl(r.publicUrl);
      }
    } catch (e: any) {
      alert(e.message ?? "Failed to update public sharing");
    } finally { setBusy(false); }
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this public link:", url);
    }
  };

  return <PublicButton isPublic={isPublic} busy={busy} copied={copied} onToggle={toggle} onCopy={copy} />;
}
