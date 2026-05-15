import { useCallback, useState } from "react";
import { Upload, FileText, FileArchive, X, Check } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface FileDropZoneProps {
  accept: "pdf" | "zip";
  file: File | null;
  onFileChange: (file: File | null) => void;
  disabled?: boolean;
}

export function FileDropZone({ accept, file, onFileChange, disabled }: FileDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acceptedType = accept === "pdf" ? "application/pdf" : "application/zip";
  const acceptedExtension = accept === "pdf" ? ".pdf" : ".zip";
  const Icon = accept === "pdf" ? FileText : FileArchive;
  const label = accept === "pdf" ? "PDF Document" : "ZIP Archive";

  const validateFile = useCallback((file: File): boolean => {
    const isValidType = file.type === acceptedType || file.name.endsWith(acceptedExtension);
    if (!isValidType) {
      setError(`Please upload a ${accept.toUpperCase()} file`);
      return false;
    }
    setError(null);
    return true;
  }, [accept, acceptedType, acceptedExtension]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) setIsDragging(true);
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;

    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile && validateFile(droppedFile)) {
      onFileChange(droppedFile);
    }
  }, [disabled, validateFile, onFileChange]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && validateFile(selectedFile)) {
      onFileChange(selectedFile);
    }
    e.target.value = "";
  }, [validateFile, onFileChange]);

  const removeFile = useCallback(() => {
    onFileChange(null);
    setError(null);
  }, [onFileChange]);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="w-full">
      <motion.label
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        animate={{ scale: isDragging ? 1.02 : 1 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          "relative flex flex-col items-center justify-center w-full h-48 border-2 border-dashed rounded-xl cursor-pointer transition-all duration-300 overflow-hidden",
          isDragging && "border-primary bg-primary/5",
          file && "border-success bg-success/5",
          error && "border-destructive bg-destructive/5",
          !file && !error && !isDragging && "border-border hover:border-primary/50 hover:bg-muted/50",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        {/* Animated drop ripple */}
        {isDragging && (
          <>
            <span className="pointer-events-none absolute inset-2 rounded-lg border-2 border-primary/30 animate-pulse" />
            <span className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-primary/10 animate-aurora" />
          </>
        )}

        <input
          type="file"
          accept={acceptedExtension}
          onChange={handleFileInput}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed z-10"
          disabled={disabled}
        />

        <AnimatePresence mode="wait" initial={false}>
          {file ? (
            <motion.div
              key="file"
              initial={{ opacity: 0, scale: 0.85, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
              className="flex flex-col items-center gap-3 relative z-[5]"
            >
              <motion.div
                initial={{ scale: 0, rotate: -90 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ duration: 0.5, delay: 0.05, ease: [0.34, 1.56, 0.64, 1] }}
                className="flex items-center justify-center w-14 h-14 rounded-full bg-success/10 ring-4 ring-success/5"
              >
                <Check className="w-7 h-7 text-success" strokeWidth={3} />
              </motion.div>
              <div className="text-center">
                <p className="font-medium text-foreground truncate max-w-[200px]">{file.name}</p>
                <p className="text-sm text-muted-foreground">{formatFileSize(file.size)}</p>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  removeFile();
                }}
                className="absolute top-3 right-3 p-1.5 rounded-full bg-muted hover:bg-destructive/10 hover:text-destructive transition-all hover:scale-110 active:scale-95 z-20"
                disabled={disabled}
              >
                <X className="w-4 h-4" />
              </button>
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-3 relative z-[5]"
            >
              <motion.div
                animate={{
                  scale: isDragging ? 1.15 : 1,
                  y: isDragging ? -4 : 0,
                  rotate: isDragging ? 4 : 0,
                }}
                transition={{ duration: 0.3, ease: [0.34, 1.56, 0.64, 1] }}
                className={cn(
                  "flex items-center justify-center w-14 h-14 rounded-full transition-colors",
                  isDragging ? "bg-primary/15 shadow-lg shadow-primary/20" : "bg-muted"
                )}
              >
                {isDragging ? (
                  <Upload className="w-7 h-7 text-primary animate-bounce-subtle" />
                ) : (
                  <Icon className="w-7 h-7 text-muted-foreground" />
                )}
              </motion.div>
              <div className="text-center">
                <p className="font-medium text-foreground">{label}</p>
                <p className="text-sm text-muted-foreground">
                  {isDragging ? "Drop to upload" : `Drag & drop or click to browse`}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.label>

      <AnimatePresence>
        {error && (
          <motion.p
            initial={{ opacity: 0, y: -4, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, y: -4, height: 0 }}
            className="mt-2 text-sm text-destructive overflow-hidden"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
