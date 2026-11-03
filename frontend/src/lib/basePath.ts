// Where the app is mounted, such as /bros. The on-prem server sets this with a <base>
// tag. The cloud build has no tag, so it's empty and every path below is unchanged.
export const BASE_PATH = (document.querySelector("base")?.getAttribute("href") ?? "").replace(/\/$/, "");

/** Same-origin paths from the on-prem build get the prefix. Full URLs from the cloud build don't. */
export const withBase = (path: string): string => (path?.startsWith("/") ? `${BASE_PATH}${path}` : path);
