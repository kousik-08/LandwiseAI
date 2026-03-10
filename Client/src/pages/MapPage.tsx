import { useState, useCallback } from "react";
import MapView from "@/components/map/MapView";
import InfoSidebar from "@/components/map/InfoSidebar";
import Navbar from "@/components/map/Navbar";

const MapPage = () => {
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
        <MapView onMapClick={handleMapClick} />
      </div>

      {/* Info Sidebar */}
      <InfoSidebar
        isOpen={sidebarOpen}
        onClose={handleCloseSidebar}
        latitude={selectedLocation?.lat ?? null}
        longitude={selectedLocation?.lng ?? null}
      />

      {/* Map Instructions */}
      {!sidebarOpen && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 bg-card/95 backdrop-blur-sm px-4 py-2 rounded-lg shadow-lg border border-border z-[500]">
          <p className="text-sm text-card-foreground">
            Click on map or enter coordinates to view land details
          </p>
        </div>
      )}
    </div>
  );
};

export default MapPage;
