import { useCallback, useRef, useState } from "react";

/**
 * Wires HTML5 drag-and-drop file upload onto a container's event handlers.
 * Nested children fire their own dragenter/dragleave as the pointer crosses
 * them, so a depth counter is used to only flip `isDragging` off once the
 * pointer truly leaves the container rather than just moving between its
 * children.
 */
export function useDropUpload(onDropFiles: (files: File[]) => void) {
  const [isDragging, setIsDragging] = useState(false);
  const depth = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    depth.current++;
    setIsDragging(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setIsDragging(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) onDropFiles(files);
  }, [onDropFiles]);

  return { isDragging, dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
