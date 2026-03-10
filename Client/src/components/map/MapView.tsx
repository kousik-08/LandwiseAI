import { useEffect, useRef, useState } from "react";
import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import OSM from "ol/source/OSM";
import XYZ from "ol/source/XYZ";
import { fromLonLat, toLonLat } from "ol/proj";
import { Feature } from "ol";
import { Point } from "ol/geom";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import { Style, Circle, Fill, Stroke, Icon } from "ol/style";
import GeoJSON from "ol/format/GeoJSON";
import { Button } from "@/components/ui/button";
import { Layers, MapIcon, Satellite, Navigation, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import "ol/ol.css";

interface MapViewProps {
  onMapClick: (lat: number, lng: number) => void;
}

const MapView = ({ onMapClick }: MapViewProps) => {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<Map | null>(null);
  const markerLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const markerSourceRef = useRef<VectorSource | null>(null);
  const fmbLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const districtLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const osmLayerRef = useRef<TileLayer<OSM> | null>(null);
  const satelliteLayerRef = useRef<TileLayer<XYZ> | null>(null);
  const labelsLayerRef = useRef<TileLayer<XYZ> | null>(null);
  const govindacheriLayerRef = useRef<VectorLayer<VectorSource> | null>(null);

  const [showFMB, setShowFMB] = useState(false);
  const [showDistrict, setShowDistrict] = useState(false);
  const [showGovindacheri, setShowGovindacheri] = useState(true);
  const [isSatellite, setIsSatellite] = useState(false);
  const [inputLat, setInputLat] = useState("");
  const [inputLng, setInputLng] = useState("");

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    // Create OSM layer
    const osmLayer = new TileLayer({
      source: new OSM(),
    });
    osmLayerRef.current = osmLayer;

    // Create Satellite layer (using Esri World Imagery)
    const satelliteLayer = new TileLayer({
      source: new XYZ({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        maxZoom: 19,
      }),
      visible: false,
    });
    satelliteLayerRef.current = satelliteLayer;

    // Create Labels overlay layer (for satellite view)
    const labelsLayer = new TileLayer({
      source: new XYZ({
        url: "https://{a-c}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
        maxZoom: 19,
      }),
      visible: false,
    });
    labelsLayerRef.current = labelsLayer;

    // Create FMB GeoJSON layer
    const fmbSource = new VectorSource({
      url: "/geojson/fmb.geojson",
      format: new GeoJSON({
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      }),
    });

    const fmbLayer = new VectorLayer({
      source: fmbSource,
      style: new Style({
        stroke: new Stroke({
          color: "#3b82f6",
          width: 2,
        }),
        fill: new Fill({
          color: "rgba(59, 130, 246, 0.1)",
        }),
      }),
    });
    fmbLayerRef.current = fmbLayer;

    const districtSource = new VectorSource({
      url: "/geojson/district.geojson",
      format: new GeoJSON({
        dataProjection: "EPSG:4326", // CRS84 is lon/lat → treat as 4326
        featureProjection: "EPSG:3857", // map projection
      }),
    });

    const districtLayer = new VectorLayer({
      source: districtSource,
      style: new Style({
        stroke: new Stroke({
          color: "#ef4444",
          width: 2,
        }),
        fill: new Fill({
          color: "rgba(239, 68, 68, 0.1)",
        }),
      }),
    });
    districtLayerRef.current = districtLayer;

    // Create Govindacheri GeoJSON layer
    const govindacheriSource = new VectorSource({
      url: "/geojson/govindacheri.geojson",
      format: new GeoJSON({
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      }),
    });

    const govindacheriLayer = new VectorLayer({
      source: govindacheriSource,
      style: new Style({
        stroke: new Stroke({
          color: "#10b981",
          width: 2,
        }),
        fill: new Fill({
          color: "rgba(16, 185, 129, 0.1)",
        }),
      }),
    });
    govindacheriLayerRef.current = govindacheriLayer;

    // Create marker layer with pin icon
    const markerSource = new VectorSource();
    markerSourceRef.current = markerSource;
    const markerLayer = new VectorLayer({
      source: markerSource,
      style: new Style({
        image: new Icon({
          anchor: [0.5, 1],
          anchorXUnits: "fraction",
          anchorYUnits: "fraction",
          src:
            "data:image/svg+xml;utf8," +
            encodeURIComponent(`
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="42" viewBox="0 0 32 42">
              <path fill="%23ef4444" stroke="%23ffffff" stroke-width="2" d="M16 0C9.373 0 4 5.373 4 12c0 8.5 12 30 12 30s12-21.5 12-30c0-6.627-5.373-12-12-12z"/>
              <circle cx="16" cy="12" r="5" fill="%23ffffff"/>
            </svg>
          `),
          scale: 1,
        }),
      }),
      zIndex: 1000, // Ensure marker is on top
    });
    markerLayerRef.current = markerLayer;

    // Initialize map with extent-based view (centered on Govindacheri area)
    const extent = [
      ...fromLonLat([79.43, 13.00]), // minX (lon), minY (lat)
      ...fromLonLat([79.49, 13.05]), // maxX (lon), maxY (lat)
    ];

    const view = new View({
      // Extent only used for initial fit, not as a constraint
    });

    const map = new Map({
      target: mapRef.current,
      layers: [
        osmLayer,
        satelliteLayer,
        labelsLayer,
        fmbLayer,
        districtLayer,
        govindacheriLayer,
        markerLayer,
      ],
      view: view,
    });

    // Fit to extent after map has a size
    map.once("postrender", () => {
      view.fit(extent, {
        padding: [40, 40, 40, 40],
      });
    });

    fmbLayer.setZIndex(10);
    districtLayer.setZIndex(5);
    govindacheriLayer.setZIndex(15);
    markerLayer.setZIndex(100);

    // Handle map clicks
    map.on("click", (event) => {
      const coordinate = event.coordinate;

      // Convert from Web Mercator to WGS84 using toLonLat
      const [lng, lat] = toLonLat(coordinate);

      // Clear existing markers
      markerSource.clear();

      // Add new marker at clicked location
      const marker = new Feature({
        geometry: new Point(coordinate),
      });
      markerSource.addFeature(marker);

      onMapClick(lat, lng);
    });

    mapInstanceRef.current = map;

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.setTarget(undefined);
        mapInstanceRef.current = null;
      }
    };
  }, [onMapClick]);

  // Toggle FMB layer visibility
  useEffect(() => {
    if (fmbLayerRef.current) {
      fmbLayerRef.current.setVisible(showFMB);
    }
  }, [showFMB]);

  // Toggle District layer visibility
  useEffect(() => {
    if (districtLayerRef.current) {
      districtLayerRef.current.setVisible(showDistrict);
    }
  }, [showDistrict]);

  // Toggle Govindacheri layer visibility
  useEffect(() => {
    if (govindacheriLayerRef.current) {
      govindacheriLayerRef.current.setVisible(showGovindacheri);
    }
  }, [showGovindacheri]);

  // Toggle between satellite and street view
  useEffect(() => {
    if (
      osmLayerRef.current &&
      satelliteLayerRef.current &&
      labelsLayerRef.current
    ) {
      osmLayerRef.current.setVisible(!isSatellite);
      satelliteLayerRef.current.setVisible(isSatellite);
      labelsLayerRef.current.setVisible(isSatellite); // Show labels only in satellite mode
    }
  }, [isSatellite]);

  const handleCoordinateSearch = () => {
    const lat = parseFloat(inputLat);
    const lng = parseFloat(inputLng);

    if (isNaN(lat) || isNaN(lng)) {
      alert("Please enter valid latitude and longitude");
      return;
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      alert("Invalid coordinate range");
      return;
    }

    if (mapInstanceRef.current && markerSourceRef.current) {
      const coordinate = fromLonLat([lng, lat]);

      // Update marker
      markerSourceRef.current.clear();
      const marker = new Feature({
        geometry: new Point(coordinate),
      });
      markerSourceRef.current.addFeature(marker);

      // Center map
      mapInstanceRef.current.getView().animate({
        center: coordinate,
        zoom: 17,
        duration: 1000
      });

      // Trigger sidebar update
      onMapClick(lat, lng);
    }
  };

  return (
    <div className="relative w-full h-full" style={{ minHeight: "100vh" }}>
      <div ref={mapRef} className="w-full h-full" />

      {/* Coordinate Input Panel */}
      <div className="absolute top-4 left-4 z-[500] flex flex-col gap-3 p-4 bg-background/95 backdrop-blur shadow-xl rounded-xl border border-border w-72">
        <div className="flex items-center gap-2 mb-1">
          <Navigation className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Go to Coordinates</h3>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="lat" className="text-[10px] uppercase tracking-wider text-muted-foreground">Latitude</Label>
            <Input
              id="lat"
              type="text"
              placeholder="e.g. 13.01"
              value={inputLat}
              onChange={(e) => setInputLat(e.target.value)}
              className="h-9 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lng" className="text-[10px] uppercase tracking-wider text-muted-foreground">Longitude</Label>
            <Input
              id="lng"
              type="text"
              placeholder="e.g. 79.46"
              value={inputLng}
              onChange={(e) => setInputLng(e.target.value)}
              className="h-9 text-xs"
            />
          </div>
        </div>

        <Button
          onClick={handleCoordinateSearch}
          className="w-full mt-1 bg-primary hover:bg-primary/90 text-primary-foreground h-9"
        >
          <Search className="h-4 w-4 mr-2" />
          Search Location
        </Button>
      </div>

      {/* Layer Controls */}
      <div className="absolute top-4 right-4 z-[500] flex flex-col gap-2">
        {/* Satellite/Street Toggle */}
        <Button
          onClick={() => setIsSatellite(!isSatellite)}
          variant={isSatellite ? "default" : "outline"}
          size="sm"
          className="shadow-lg"
        >
          {isSatellite ? (
            <>
              <Satellite className="h-4 w-4 mr-2" />
              Satellite
            </>
          ) : (
            <>
              <MapIcon className="h-4 w-4 mr-2" />
              Street
            </>
          )}
        </Button>

        {/* FMB Layer Toggle */}
        <Button
          onClick={() => setShowFMB(!showFMB)}
          variant={showFMB ? "default" : "outline"}
          size="sm"
          className="shadow-lg"
        >
          <Layers className="h-4 w-4 mr-2" />
          FMB Layer
        </Button>

        {/* District Layer Toggle */}
        <Button
          onClick={() => setShowDistrict(!showDistrict)}
          variant={showDistrict ? "default" : "outline"}
          size="sm"
          className="shadow-lg"
        >
          <Layers className="h-4 w-4 mr-2" />
          District
        </Button>

        {/* Govindacheri Layer Toggle */}
        <Button
          onClick={() => setShowGovindacheri(!showGovindacheri)}
          variant={showGovindacheri ? "default" : "outline"}
          size="sm"
          className="shadow-lg border-emerald-500 text-emerald-600 hover:text-emerald-700"
          style={showGovindacheri ? { backgroundColor: '#10b981', borderColor: '#10b981' } : {}}
        >
          <Layers className="h-4 w-4 mr-2" />
          Govindacheri
        </Button>
      </div>
    </div>
  );
};

export default MapView;
