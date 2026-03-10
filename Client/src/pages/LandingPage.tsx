import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { MapIcon, FileCheck } from "lucide-react";

const LandingPage = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4">
      <div className="max-w-4xl w-full space-y-8 text-center">
        <div className="space-y-4">
          <h1 className="text-4xl font-bold tracking-tight lg:text-5xl">
            Welcome to Pattaflow
          </h1>
          <p className="text-xl text-muted-foreground">
            Make land verification and analysis simple and efficient.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8 mt-12">
          {/* Map Option */}
          <div
            className="group relative overflow-hidden rounded-xl border bg-card p-8 hover:shadow-2xl transition-all cursor-pointer flex flex-col items-center text-center space-y-6"
            onClick={() => navigate("/map")}
          >
            <div className="p-4 rounded-full bg-primary/10 group-hover:bg-primary/20 transition-colors">
              <MapIcon className="w-12 h-12 text-primary" />
            </div>
            <div className="space-y-2">
              <h3 className="text-2xl font-semibold">Map & Land Details</h3>
              <p className="text-muted-foreground">
                View land details on an interactive map and download Encumbrance
                Certificates.
              </p>
            </div>
            <Button className="w-full mt-auto" size="lg">
              Explore Map
            </Button>
          </div>

          {/* Verification Option */}
          <div
            className="group relative overflow-hidden rounded-xl border bg-card p-8 hover:shadow-2xl transition-all cursor-pointer flex flex-col items-center text-center space-y-6"
            onClick={() => navigate("/verify")}
          >
            <div className="p-4 rounded-full bg-secondary/10 group-hover:bg-primary/20 transition-colors">
              <FileCheck className="w-12 h-12 text-secondary-foreground" />
            </div>
            <div className="space-y-2">
              <h3 className="text-2xl font-semibold">Verify Documents</h3>
              <p className="text-muted-foreground">
                Validate Encumbrance Certificates against Sale Deeds
                efficiently.
              </p>
            </div>
            <Button variant="secondary" className="w-full mt-auto" size="lg">
              Start Verification
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LandingPage;
