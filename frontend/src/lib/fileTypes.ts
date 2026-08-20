// Extension -> category, used to decide whether a file row gets an image/video
// thumbnail, a play button, or just the generic file icon. There's no
// server-side Content-Type in the browse/explorer list responses, so this is
// inferred purely from the filename.

export type FileCategory = "image" | "video" | "audio" | "pdf" | "text" | "other";

const IMAGE_EXT = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "heic", "heif",
]);
const VIDEO_EXT = new Set([
  "mp4", "webm", "mov", "m4v", "mkv", "avi", "ogv",
]);
const AUDIO_EXT = new Set([
  "mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus",
]);
const PDF_EXT = new Set(["pdf"]);
// Plain-text formats only -- source code files aren't included on purpose
// (this feeds an inline preview, not a code viewer).
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv", "json", "yaml", "yml", "ini", "conf",
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
  if (PDF_EXT.has(ext)) return "pdf";
  if (TEXT_EXT.has(ext)) return "text";
  return "other";
}

const CATEGORY_EMOJI: Record<FileCategory, string> = {
  image: "🖼️",
  video: "🎬",
  audio: "🎵",
  pdf: "📕",
  text: "📝",
  other: "📄",
};

export function emojiFor(category: FileCategory): string {
  return CATEGORY_EMOJI[category];
}
