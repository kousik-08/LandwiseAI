import { useCallback, useState } from "react";
import { Upload, FileText, FileArchive, X, Check } from "lucide-react";
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
      <label
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "relative flex flex-col items-center justify-center w-full h-48 border-2 border-dashed rounded-xl cursor-pointer transition-all duration-300",
          isDragging && "border-primary bg-primary/5 scale-[1.02]",
          file && "border-success bg-success/5",
          error && "border-destructive bg-destructive/5",
          !file && !error && !isDragging && "border-border hover:border-primary/50 hover:bg-muted/50",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        <input
          type="file"
          accept={acceptedExtension}
          onChange={handleFileInput}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
          disabled={disabled}
        />
        
        {file ? (
          <div className="flex flex-col items-center gap-3 animate-fade-in">
            <div className="flex items-center justify-center w-14 h-14 rounded-full bg-success/10">
              <Check className="w-7 h-7 text-success" />
            </div>
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
              className="absolute top-3 right-3 p-1.5 rounded-full bg-muted hover:bg-destructive/10 hover:text-destructive transition-colors"
              disabled={disabled}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className={cn(
              "flex items-center justify-center w-14 h-14 rounded-full transition-colors",
              isDragging ? "bg-primary/10" : "bg-muted"
            )}>
              {isDragging ? (
                <Upload className="w-7 h-7 text-primary animate-bounce" />
              ) : (
                <Icon className="w-7 h-7 text-muted-foreground" />
              )}
            </div>
            <div className="text-center">
              <p className="font-medium text-foreground">{label}</p>
              <p className="text-sm text-muted-foreground">
                {isDragging ? "Drop to upload" : `Drag & drop or click to browse`}
              </p>
            </div>
          </div>
        )}
      </label>
      
      {error && (
        <p className="mt-2 text-sm text-destructive animate-fade-in">{error}</p>
      )}
    </div>
  );
}
