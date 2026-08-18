// Extension -> category, used to decide whether a file row gets an image/video
// thumbnail, a play button, or just the generic file icon. There's no
// server-side Content-Type in the browse/explorer list responses, so this is
// inferred purely from the filename.

export type FileCategory = "image" | "video" | "audio" | "other";

const IMAGE_EXT = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "heic", "heif",
]);
const VIDEO_EXT = new Set([
  "mp4", "webm", "mov", "m4v", "mkv", "avi", "ogv",
]);
const AUDIO_EXT = new Set([
  "mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

export function categoryFor(name: string): FileCategory {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return "other";
}

const CATEGORY_EMOJI: Record<FileCategory, string> = {
  image: "🖼️",
  video: "🎬",
  audio: "🎵",
  other: "📄",
};

export function emojiFor(category: FileCategory): string {
  return CATEGORY_EMOJI[category];
}
