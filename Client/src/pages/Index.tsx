import { UploadForm } from "@/components/UploadForm";
import { motion } from "framer-motion";
import { FileUp, ListChecks, GitBranch } from "lucide-react";

const STEPS = [
  { icon: FileUp, label: "Upload", desc: "Drop the EC PDF and the deeds ZIP" },
  { icon: ListChecks, label: "Validate", desc: "Field-by-field forensic check vs. registry data" },
  { icon: GitBranch, label: "Audit", desc: "Title hierarchy + chain-of-title verdict" },
];

const Index = () => {
  return (
    <div className="min-h-screen relative overflow-hidden">
      {/* Background flourish (sits under the AppShell header) */}
      <div className="absolute inset-0 -z-10 pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px] animate-blob" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/5 rounded-full blur-[120px] animate-blob-slow" />
        <div
          className="absolute inset-0 opacity-[0.025]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #0C1829 1px, transparent 1px), linear-gradient(to bottom, #0C1829 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
      </div>

      <main className="container mx-auto px-4 py-8 sm:py-12">
        <div className="w-full mx-auto">
          {/* Intro + step indicator */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="text-center mb-8 sm:mb-12 space-y-4"
          >
            <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-foreground">
              Verify a <span className="text-gradient-primary">Land Parcel</span>
            </h2>
            <p className="text-sm sm:text-base text-muted-foreground max-w-xl mx-auto">
              Upload the Encumbrance Certificate and registration deeds. The pipeline runs
              extraction, matching, validation and audit — then takes you straight to the
              title hierarchy.
            </p>

            {/* Stepper */}
            <ol className="flex flex-wrap items-center justify-center gap-2 sm:gap-4 pt-2">
              {STEPS.map((s, i) => {
                const Icon = s.icon;
                return (
                  <li key={s.label} className="flex items-center gap-2 sm:gap-4">
                    <div className="flex items-center gap-2 px-3 py-2 rounded-full bg-white border border-slate-200 shadow-sm">
                      <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-[11px] font-black flex items-center justify-center">
                        {i + 1}
                      </span>
                      <Icon className="w-4 h-4 text-primary" />
                      <span className="text-xs font-bold text-slate-700 hidden sm:inline">{s.label}</span>
                      <span className="text-[10px] text-slate-400 hidden md:inline">— {s.desc}</span>
                    </div>
                    {i < STEPS.length - 1 && (
                      <span className="text-slate-300 text-sm hidden sm:inline">→</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </motion.div>

          {/* Upload form */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            <UploadForm />
          </motion.div>
        </div>
      </main>
    </div>
  );
};

export default Index;
