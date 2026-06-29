import { useEffect, useRef, useState } from "react";
import Map from "ol/Map";
import View from "ol/View";
import Overlay from "ol/Overlay";
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
import { Badge } from "@/components/ui/badge";
import { Layers, MapIcon, Satellite, Navigation, Search, MapPin, User, Maximize } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import "ol/ol.css";

interface MapViewProps {
  onMapClick: (lat: number, lng: number) => void;
  highlightSurveyNumber?: string | null;
  metadata?: any | null;
}

// Static styles for land highlighting
const yellowStyle = new Style({
  stroke: new Stroke({
    color: "#eab308", // amber/yellow
    width: 3,
  }),
  fill: new Fill({
    color: "rgba(234, 179, 8, 0.2)", // translucent yellow
  }),
});

const blackStyle = new Style({
  stroke: new Stroke({
    color: "#1e1b4b", // deep indigo (indigo-950)
    width: 4,
  }),
  fill: new Fill({
    color: "rgba(30, 27, 75, 0.25)", // translucent deep indigo
  }),
});

const MapView = ({ onMapClick, highlightSurveyNumber, metadata }: MapViewProps) => {
  const mapRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<Map | null>(null);
  const overlayRef = useRef<Overlay | null>(null);
  const markerLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const markerSourceRef = useRef<VectorSource | null>(null);
  const fmbLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const districtLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const osmLayerRef = useRef<TileLayer<OSM> | null>(null);
  const satelliteLayerRef = useRef<TileLayer<XYZ> | null>(null);
  const labelsLayerRef = useRef<TileLayer<XYZ> | null>(null);
  const govindacheriLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const highlightLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const highlightSourceRef = useRef<VectorSource | null>(null);
  const metadataRef = useRef<any | null>(null);

  const [hoveredMetadata, setHoveredMetadata] = useState<any | null>(null);
  const [showFMB, setShowFMB] = useState(false);
  const [showDistrict, setShowDistrict] = useState(false);
  const [showGovindacheri, setShowGovindacheri] = useState(true);
  const [isSatellite, setIsSatellite] = useState(false);
  const [inputLat, setInputLat] = useState("");
  const [inputLng, setInputLng] = useState("");

  // Sync metadata prop to ref for use in map event handlers
  useEffect(() => {
    metadataRef.current = metadata;
  }, [metadata]);

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

    // Create highlight layer for survey boundaries
    const highlightSource = new VectorSource();
    highlightSourceRef.current = highlightSource;

    const highlightLayer = new VectorLayer({
      source: highlightSource,
      // Default style (though we set it per-feature below)
      style: blackStyle,
    });
    highlightLayerRef.current = highlightLayer;

    // Initialize map with extent-based view (centered on Govindacheri area)
    const extent = [
      ...fromLonLat([79.43, 13.00]), // minX (lon), minY (lat)
      ...fromLonLat([79.49, 13.05]), // maxX (lon), maxY (lat)
    ];

    const view = new View({
      // Extent only used for initial fit, not as a constraint
    });

    // Create Tooltip Overlay
    const tooltipOverlay = new Overlay({
      element: tooltipRef.current!,
      positioning: "bottom-center",
      stopEvent: false,
      offset: [0, -18], // Increased vertical offset for better visibility above parcel
    });
    overlayRef.current = tooltipOverlay;

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
        highlightLayer,
      ],
      overlays: [tooltipOverlay],
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
    highlightLayer.setZIndex(200);

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

      // Hide tooltip on new click
      overlayRef.current?.setPosition(undefined);

      onMapClick(lat, lng);
    });

    // Unified normalization function
    const norm = (v: any) =>
      String(v)
        .trim()
        .toLowerCase()
        .replace(/-/g, "/")
        .replace(/–/g, "/")
        .replace(/[^0-9a-z/]/g, "");

    // Handle hovering over parcels
    map.on("pointermove", (e) => {
      if (e.dragging) return;
      
      const pixel = map.getEventPixel(e.originalEvent);
      let hoveredFeat: any = null;
      
      map.forEachFeatureAtPixel(pixel, (feat: any) => {
        const props = feat.getProperties();
        const kide = props.KIDE || props.kide;
        if (kide) {
          hoveredFeat = feat;
          return true;
        }
      });

      if (hoveredFeat) {
        const props = hoveredFeat.getProperties();
        const kideRaw = props.KIDE || props.kide || "";
        const kideNorm = norm(kideRaw);
        const areaRaw = props.Area || props.area || "N/A";
        
        // Normalize area display for hovered parcel
        const displayArea = isNaN(parseFloat(areaRaw)) 
          ? areaRaw 
          : `${parseFloat(areaRaw).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} sq.ft`;
        
        const pinned = metadataRef.current;
        // Support multiple survey numbers in pinned metadata for correctly showing tooltips
        const pinnedSurveys = pinned ? String(pinned.surveyNumber).split(',').map(s => norm(s)).filter(s => !!s) : [];
        
        // Match if kideNorm matches any of the pinned survey numbers (or is a subdivision of a mother survey)
        const isMatch = pinnedSurveys.some(pNorm => {
             const pIsBase = !pNorm.includes('/');
             if (pIsBase) {
                 return kideNorm === pNorm || kideNorm.startsWith(pNorm + "/");
             }
             return kideNorm === pNorm;
        });

        if (isMatch) {
          setHoveredMetadata(pinned);
          
          // Snap to parcel center
          const geom = hoveredFeat.getGeometry();
          if (geom) {
            const extent = geom.getExtent();
            const center = [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2];
            overlayRef.current?.setPosition(center);
          }
          map.getTargetElement().style.cursor = 'pointer';
        } else {
          // If no content match, hide tooltip to avoid generic info showing on every parcel
          setHoveredMetadata(null);
          overlayRef.current?.setPosition(undefined);
          map.getTargetElement().style.cursor = 'pointer'; 
        }
      } else {
        setHoveredMetadata(null);
        map.getTargetElement().style.cursor = '';
        overlayRef.current?.setPosition(undefined);
      }
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
      // Hide tooltip when manually searching coordinates
      overlayRef.current?.setPosition(undefined);

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

  // Core logic to highlight survey boundaries by survey number(s) using govindacheri.geojson.
  // Supports comma-separated strings for multiple survey numbers (e.g., "13, 13/3").
  const highlightBySurveyNumber = (raw: string | null) => {
    if (!raw) return;

    // Normalize and split by comma to handle multiple survey numbers
    const parts = raw.split(',').map(p => p.trim());
    const targetCleans = parts.map(p => {
        let n = p.toLowerCase();
        n = n.replace(/^s\.?\s*no[:.\s-]*/i, ""); // remove leading "S.No:"
        n = n.replace(/-/g, "/").replace(/–/g, "/"); // normalize separators
        n = n.split(/\s+/)[0]; // take the first token (survey/subdiv)
        return n.replace(/[^0-9a-z/]/g, ""); // strip non-alphanumeric except /
    }).filter(tc => !!tc);

    console.log("MapView: highlightBySurveyNumbers raw=", raw, "targets=", targetCleans);

    if (targetCleans.length === 0) return;

    const map = mapInstanceRef.current;
    const highlightSource = highlightSourceRef.current;

    // If map or highlight layer are not yet ready (initial render race), retry shortly.
    if (!map || !highlightSource) {
      setTimeout(() => highlightBySurveyNumber(raw), 300);
      return;
    }

    // Clear old highlight
    highlightSource.clear();

    // NEW: Read govindacheri.geojson directly and use it as the source of truth.
    // If targetClean has no "/", treat it as base survey (e.g., "13") and
    // combine all KIDE features that start with that base (13/1, 13/2, ...).
    fetch("/geojson/govindacheri.geojson")
      .then((resp) => resp.json())
      .then((fc) => {
        const features = fc.features || [];
        const norm = (v: any) =>
          String(v)
            .trim()
            .toLowerCase()
            .replace(/-/g, "/")
            .replace(/–/g, "/")
            .replace(/[^0-9a-z/]/g, "");

        const isAnyBaseSurvey = targetCleans.some(tc => !tc.includes("/"));

        const matchedFeatures = features.filter((f: any) => {
          const props = f.properties || {};
          const kideNorm = norm(
            props.KIDE ||
            props.kide ||
            props.survey_number ||
            props.SURVEY_NO ||
            props.SNO ||
            props.S_NO
          );
          if (!kideNorm) return false;

          // Check if kideNorm matches any of the targetCleans
          return targetCleans.some(tc => {
              const tcIsBase = !tc.includes("/");
              if (tcIsBase) {
                  const base = kideNorm.split("/")[0];
                  return base === tc;
              }
              return kideNorm === tc;
          });
        });

        if (matchedFeatures.length === 0) {
          console.warn("No survey boundary found in GeoJSON for tokens:", targetCleans, "from raw:", raw);
          return;
        }

        console.log(
          "Highlighting from GeoJSON for tokens:",
          targetCleans,
          "matched KIDEs=",
          matchedFeatures.map((m: any) => m.properties?.KIDE)
        );

        const format = new GeoJSON({
          dataProjection: "EPSG:4326",
          featureProjection: "EPSG:3857",
        });

        highlightSource.clear();

        let combinedExtent: number[] | null = null;
        let centerForMarker: number[] | null = null;

        matchedFeatures.forEach((mf: any) => {
          const props = mf.properties || {};
          const kideRaw = props.KIDE || props.kide || "";
          const kideNorm = norm(kideRaw);

          // If kideNorm is explicitly present in targetCleans, it's a specific match (Black)
          // Otherwise it's part of a mother survey match (Yellow)
          const isSpecific = targetCleans.includes(kideNorm);
          
          const features = format.readFeatures(mf);
          features.forEach((feat: any) => {
            feat.setStyle(isSpecific ? blackStyle : yellowStyle);
            highlightSource.addFeature(feat);
            const geom = feat.getGeometry();
            const extent = geom?.getExtent();
            if (extent) {
              if (!combinedExtent) {
                combinedExtent = extent.slice() as number[];
                // Use extent center as it is safe for both Polygon and MultiPolygon
                centerForMarker = [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2];
              } else {
                combinedExtent[0] = Math.min(combinedExtent[0], extent[0]);
                combinedExtent[1] = Math.min(combinedExtent[1], extent[1]);
                combinedExtent[2] = Math.max(combinedExtent[2], extent[2]);
                combinedExtent[3] = Math.max(combinedExtent[3], extent[3]);
              }
            }
          });
        });

        if (combinedExtent) {
          const view = map.getView();
          // Fit view so the entire combined mother-survey block is visible
          view.fit(combinedExtent, {
            padding: [100, 100, 100, 100],
            duration: 1000,
          });

          const center =
            centerForMarker ||
            [(combinedExtent[0] + combinedExtent[2]) / 2, (combinedExtent[1] + combinedExtent[3]) / 2];

          // Center map with reasonable zoom level
          const currentZoom = view.getZoom() ?? 0;
          if (isAnyBaseSurvey) {
              // For base survey, we already fitted the extent, no need to zoom in further
          } else {
              // For specific subdivision, we can zoom in slightly more
              view.animate({
                  center,
                  zoom: Math.max(currentZoom, 18),
                  duration: 800,
              });
          }

          // Drop a marker at the centroid and notify parent via lat/lng
          if (markerSourceRef.current) {
            markerSourceRef.current.clear();
            markerSourceRef.current.addFeature(new Feature(new Point(center)));
          }

          // Restore initial tooltip for the searched survey
          if (metadata && overlayRef.current) {
            overlayRef.current.setPosition(center);
          }

          const [lng, lat] = toLonLat(center);
          onMapClick(lat, lng);
        }
      })
      .catch((err) => {
        console.error("Failed to load govindacheri.geojson for highlight:", err);
      });
  };

  // React to changes in the requested survey number (e.g., when opened from "View on Map").
  useEffect(() => {
    if (!highlightSurveyNumber) return;
    console.log("MapView: highlightSurveyNumber changed ->", highlightSurveyNumber);
    highlightBySurveyNumber(highlightSurveyNumber);
  }, [highlightSurveyNumber]);

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

      {/* Rich Metadata Tooltip */}
      <div 
        ref={tooltipRef}
        className="bg-white/95 backdrop-blur-md p-4 rounded-xl shadow-2xl border border-slate-200 min-w-[280px] pointer-events-none select-none"
        style={{ display: hoveredMetadata ? 'block' : 'none' }}
      >
        {hoveredMetadata && (
          <div className="space-y-3">
            {(() => {
              const info = hoveredMetadata || metadata;
              return (
                <>
                <div className="flex items-center justify-between border-b pb-2">
                  <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-primary" />
                    S.No: {info.surveyNumber}
                  </h4>
                  <Badge variant="outline" className="text-[10px] font-bold uppercase tracking-tight bg-primary/5 text-primary border-primary/20">
                    {info.nature}
                  </Badge>
                </div>
                
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <div className="space-y-0.5">
                    <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                      <User className="w-2.5 h-2.5" /> Executant
                    </span>
                    <p className="text-[11px] font-bold text-slate-800 line-clamp-1">{info.executant}</p>
                  </div>
                  <div className="space-y-0.5">
                    <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                      <User className="w-2.5 h-2.5" /> Claimant
                    </span>
                    <p className="text-[11px] font-bold text-slate-800 line-clamp-1">{info.claimant}</p>
                  </div>
                  <div className="space-y-0.5">
                    <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                      <Maximize className="w-2.5 h-2.5 text-primary/70" /> Area
                    </span>
                    <p className="text-[11px] font-bold text-slate-800">{info.area}</p>
                  </div>
                  <div className="space-y-0.5">
                    <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                      <Navigation className="w-2.5 h-2.5 text-primary/70" /> Land Type
                    </span>
                    <p className="text-[11px] font-bold text-slate-800">{info.landType}</p>
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-[8px] font-bold text-slate-400 uppercase tracking-tighter">Document Number</span>
                    <span className="text-[10px] font-extrabold text-indigo-600">{hoveredMetadata.docNo}</span>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="text-[8px] font-bold text-slate-400 uppercase tracking-tighter">Registration Date</span>
                    <span className="text-[10px] font-bold text-slate-600">{hoveredMetadata.date}</span>
                  </div>
                </div>
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
};

export default MapView;
