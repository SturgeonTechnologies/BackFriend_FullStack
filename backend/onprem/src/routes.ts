// The API routes in ../template.yaml, as the on-prem gateway serves them.
// test/routes.test.ts fails if this list and the SAM template ever disagree.
import { handler as createInvite } from "../../src/handlers/admin/createInvite";
import { handler as listInvites } from "../../src/handlers/admin/listInvites";
import { handler as revokeInvite } from "../../src/handlers/admin/revokeInvite";
import { handler as listAccess } from "../../src/handlers/admin/listAccess";
import { handler as createMount } from "../../src/handlers/admin/createMount";
import { handler as updateMount } from "../../src/handlers/admin/updateMount";
import { handler as deleteMount } from "../../src/handlers/admin/deleteMount";
import { handler as exploreBucket } from "../../src/handlers/admin/exploreBucket";
import { handler as createFolder } from "../../src/handlers/admin/createFolder";
import { handler as deleteDirectory } from "../../src/handlers/admin/deleteDirectory";
import { handler as exploreDownloadUrl } from "../../src/handlers/admin/exploreDownloadUrl";
import { handler as exploreDeleteFile } from "../../src/handlers/admin/exploreDeleteFile";
import { handler as explorePublic } from "../../src/handlers/admin/explorePublic";
import { handler as setPublic } from "../../src/handlers/admin/setPublic";
import { handler as unsetPublic } from "../../src/handlers/admin/unsetPublic";
import { handler as resolvePublic } from "../../src/handlers/public/resolvePublic";
import { handler as listMounts } from "../../src/handlers/user/listMounts";
import { handler as search } from "../../src/handlers/user/search";
import { handler as browseList } from "../../src/handlers/user/browseList";
import { handler as getMountAccess } from "../../src/handlers/user/getMountAccess";
import { handler as updateMountAccess } from "../../src/handlers/user/updateMountAccess";
import { handler as browseDownloadUrl } from "../../src/handlers/user/browseDownloadUrl";
import { handler as uploadUrl } from "../../src/handlers/user/uploadUrl";
import { handler as archiveUploadUrl } from "../../src/handlers/user/archiveUploadUrl";
import { handler as archivePublic } from "../../src/handlers/user/archivePublic";
import { handler as archiveUnpublic } from "../../src/handlers/user/archiveUnpublic";
import { handler as archiveList } from "../../src/handlers/user/archiveList";
import { handler as archiveDownloadUrl } from "../../src/handlers/user/archiveDownloadUrl";
import { handler as archiveDelete } from "../../src/handlers/user/archiveDelete";
import { handler as deleteFile } from "../../src/handlers/user/deleteFile";

export interface Route {
  method: string;
  path: string;
  handler: (event: any, context?: any, callback?: any) => any;
  /** Reachable without a token. Absent means sign-in is required. */
  public?: true;
}

export const ROUTES: Route[] = [
  { method: "POST", path: "/admin/invites", handler: createInvite },
  { method: "GET", path: "/admin/invites", handler: listInvites },
  { method: "DELETE", path: "/admin/invites/{email}", handler: revokeInvite },
  { method: "GET", path: "/admin/access", handler: listAccess },
  { method: "POST", path: "/admin/mounts", handler: createMount },
  { method: "PUT", path: "/admin/mounts/{mountPath}", handler: updateMount },
  { method: "DELETE", path: "/admin/mounts/{mountPath}", handler: deleteMount },
  { method: "GET", path: "/admin/explore", handler: exploreBucket },
  { method: "POST", path: "/admin/explore/folder", handler: createFolder },
  { method: "DELETE", path: "/admin/explore/directory", handler: deleteDirectory },
  { method: "GET", path: "/admin/explore/download-url", handler: exploreDownloadUrl },
  { method: "DELETE", path: "/admin/explore/file", handler: exploreDeleteFile },
  { method: "POST", path: "/admin/explore/public", handler: explorePublic },
  { method: "DELETE", path: "/admin/explore/public", handler: explorePublic },
  { method: "POST", path: "/browse/{mountPath}/public", handler: setPublic },
  { method: "DELETE", path: "/browse/{mountPath}/public", handler: unsetPublic },
  { method: "GET", path: "/public/{token}", handler: resolvePublic, public: true },
  { method: "GET", path: "/mounts", handler: listMounts },
  { method: "GET", path: "/search", handler: search },
  { method: "GET", path: "/browse/{mountPath}", handler: browseList },
  { method: "GET", path: "/browse/{mountPath}/access", handler: getMountAccess },
  { method: "PUT", path: "/browse/{mountPath}/access", handler: updateMountAccess },
  { method: "GET", path: "/browse/{mountPath}/download-url", handler: browseDownloadUrl },
  { method: "POST", path: "/browse/{mountPath}/upload-url", handler: uploadUrl },
  { method: "POST", path: "/archive/upload-url", handler: archiveUploadUrl },
  { method: "POST", path: "/archive/public", handler: archivePublic },
  { method: "DELETE", path: "/archive/public", handler: archiveUnpublic },
  { method: "GET", path: "/archive/list", handler: archiveList },
  { method: "POST", path: "/archive/download-url", handler: archiveDownloadUrl },
  { method: "DELETE", path: "/archive/file", handler: archiveDelete },
  { method: "DELETE", path: "/browse/{mountPath}/file", handler: deleteFile },
];

export function matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | null {
  const parts = path.split("/");
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const pattern = route.path.split("/");
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const hit = pattern.every((seg, i) => {
      if (seg.startsWith("{")) {
        if (!parts[i]) return false;
        params[seg.slice(1, -1)] = parts[i];
        return true;
      }
      return seg === parts[i];
    });
    if (hit) return { route, params };
  }
  return null;
}
