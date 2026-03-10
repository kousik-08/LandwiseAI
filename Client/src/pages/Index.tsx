import { UploadForm } from "@/components/UploadForm";
import { FileUp } from "lucide-react";

const Index = () => {
  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      {/* Premium Background Elements */}
      <div className="absolute top-0 left-0 w-full h-full -z-10">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/5 rounded-full blur-[120px]" />
        <div className="absolute top-[20%] right-[10%] w-[30%] h-[30%] bg-purple-500/5 rounded-full blur-[100px]" />
      </div>
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-3">
            <img
              src="/data-flow.png"
              alt="Pattaflow Logo"
              className="h-10 w-10"
            />
            <div>
              <h1 className="text-xl font-semibold text-foreground">
                Pattaflow
              </h1>
              <p className="text-sm text-muted-foreground">
                Detailed Verification
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="container mx-auto px-4 py-12">
        <div className="w-full mx-auto">
          {/* Intro section */}
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-foreground mb-3">
              Upload Your Files
            </h2>
            <p className="text-lg text-muted-foreground max-w-xl mx-auto">
              Drop a PDF document and a ZIP archive to start processing. Watch
              the progress in real-time as your files are analyzed.
            </p>
          </div>

          {/* Upload form */}
          <UploadForm />
        </div>
      </main>
    </div>
  );
};

export default Index;
