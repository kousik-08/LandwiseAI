import { useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import MapView from "@/components/map/MapView";
import InfoSidebar from "@/components/map/InfoSidebar";
import Navbar from "@/components/map/Navbar";

const MapPage = () => {
  const [searchParams] = useSearchParams();
  const surveyNumber = searchParams.get("surveyNumber");
  const [metadata] = useState<any | null>(() => {
    if (surveyNumber) {
      const stored = sessionStorage.getItem(`map_meta_${surveyNumber}`);
      if (stored) {
        try {
          return JSON.parse(stored);
        } catch (e) {
          console.error("Failed to parse stored metadata", e);
        }
      }
    }
    return null;
  });

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState<{
    lat: number;
    lng: number;
  } | null>(null);

  const handleMapClick = useCallback((lat: number, lng: number) => {
    setSelectedLocation({ lat, lng });
    setSidebarOpen(true);
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
    setSelectedLocation(null);
  }, []);

  return (
    <div className="relative h-screen w-full overflow-hidden">
      {/* Navbar */}
      <Navbar />

      {/* Map Container - positioned below navbar */}
      <div className="absolute top-16 left-0 right-0 bottom-0">
        <MapView 
          onMapClick={handleMapClick} 
          highlightSurveyNumber={surveyNumber} 
          metadata={metadata}
        />
      </div>

      {/* Info Sidebar */}
      <InfoSidebar
        isOpen={sidebarOpen}
        onClose={handleCloseSidebar}
        latitude={selectedLocation?.lat ?? null}
        longitude={selectedLocation?.lng ?? null}
      />

      {/* Map Instructions */}
      <AnimatePresence>
        {!sidebarOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="absolute top-20 left-1/2 -translate-x-1/2 bg-card/95 backdrop-blur-md px-4 py-2 rounded-lg shadow-lg border border-border z-[500] hover:shadow-xl transition-shadow"
          >
            <p className="text-sm text-card-foreground flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
              Click on map or enter coordinates to view land details
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default MapPage;
