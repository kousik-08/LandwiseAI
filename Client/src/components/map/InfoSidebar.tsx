import { useState } from "react";
import axios from "axios";
import {
  X,
  MapPin,
  Search,
  Download,
  Loader2,
  FileText,
  Building2,
  Map,
  Eye,
} from "lucide-react";
import { API_BASE_URL } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { toast } from "sonner";

interface LandData {
  district_code: number;
  dname: string;
  taluk_code: number;
  tname: string;
  lgd_village_code: number;
  village_code: string;
  vname: string;
  kide: string;
  survey_number: string;
  sub_division: string | null;
}

interface InfoSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  latitude: number | null;
  longitude: number | null;
}

const InfoSidebar = ({
  isOpen,
  onClose,
  latitude,
  longitude,
}: InfoSidebarProps) => {
  const [landData, setLandData] = useState<LandData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [showPdfDialog, setShowPdfDialog] = useState(false);

  const API_URL = API_BASE_URL;

  const fetchLandInfo = async () => {
    if (!latitude || !longitude) return;

    setIsLoading(true);
    setHasFetched(true);

    try {
      const response = await axios.post(
        `${API_URL}/api/v1/getlandinfo`,
        {
          lat: latitude,
          lng: longitude,
        },
        {
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "X-App-Id": "te$t",
          },
        },
      );

      const result = response.data;
      console.log(result);

      if (result.statusCode === 200 && result.body && result.body.response) {
        setLandData(result.body.response);
        toast.success("Land information retrieved successfully", {
          className: "bg-green-50 border-green-200 text-green-900",
        });
      } else {
        toast.error("No data found for this location", {
          className: "bg-red-50 border-red-200 text-red-900",
        });
        setLandData(null);
      }
    } catch (error: any) {
      console.error("Error fetching land info:", error);
      if (error.response) {
        console.error("Response data:", error.response.data);
        console.error("Response status:", error.response.status);
      } else if (error.request) {
        console.error("Request made but no response received:", error.request);
      } else {
        console.error("Error message:", error.message);
      }
      toast.error("Failed to fetch land information", {
        className: "bg-red-50 border-red-200 text-red-900",
      });
      setLandData(null);
    } finally {
      setIsLoading(false);
    }
  };

  const downloadEC = async () => {
    if (!landData) return;

    setIsDownloading(true);

    try {
      if (!landData) {
        toast.error("No land data found", {
          className: "bg-red-50 border-red-200 text-red-900",
        });
        return;
      }
      const response = await axios.post(`${API_URL}/api/v1/download-ec`, {
        district_code: landData.district_code.toString(),
        taluk_code: landData.taluk_code.toString(),
        village_code: landData.village_code.toString(),
        survey_no: landData.survey_number.toString(),
        sub_div: landData.sub_division?.toString() || "-",
      });

      const result = response.data;
      console.log(result);
      if (result.statusCode === 200) {
        const path = result.body.response.pdf_path;
        setPdfPath(path);

        // Construct PDF URL
        const pdfUrl = `${API_URL}/files${path.split("outputs")[1]}`;
        console.log("PDF URL:", pdfUrl);

        toast.success("EC downloaded successfully", {
          description: `Saved to: ${path}`,
          className: "bg-green-50 border-green-200 text-green-900",
        });
      } else {
        toast.error("Failed to download EC", {
          className: "bg-red-50 border-red-200 text-red-900",
        });
      }
    } catch (error) {
      console.error("Error downloading EC:", error);
      toast.error("Failed to download EC", {
        className: "bg-red-50 border-red-200 text-red-900",
      });
    } finally {
      setIsDownloading(false);
    }
  };

  const handleClose = () => {
    setLandData(null);
    setHasFetched(false);
    setPdfPath(null);
    onClose();
  };

  if (!isOpen) return null;

  const getDisplaySurveyNumber = (data: LandData | null): string => {
    if (!data) return "N/A";

    // If KIDE is present (typically "13/3"), that is the most precise representation.
    if (data.kide) return data.kide;

    const base = data.survey_number;
    const sub = data.sub_division;
    if (!base) return "N/A";

    const baseStr = String(base);
    if (baseStr.includes("/") || !sub) return baseStr;
    return `${baseStr}/${sub}`;
  };

  return (
    <div className="fixed left-0 top-16 h-[calc(100vh-4rem)] w-96 bg-card shadow-xl z-[1000] overflow-y-auto animate-in slide-in-from-left duration-300">
      <div className="sticky top-0 bg-card z-10 border-b border-border">
        <div className="flex items-center justify-between p-4">
          <Button variant="ghost" size="icon" onClick={handleClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Coordinates Card */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Map className="h-4 w-4" />
              Coordinates
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Latitude</span>
              <span className="font-mono text-sm text-card-foreground">
                {latitude?.toFixed(6)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Longitude</span>
              <span className="font-mono text-sm text-card-foreground">
                {longitude?.toFixed(6)}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Fetch Button */}
        {!hasFetched && (
          <Button
            onClick={fetchLandInfo}
            className="w-full"
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Fetching...
              </>
            ) : (
              <>
                <Search className="h-4 w-4 mr-2" />
                Fetch Land Details
              </>
            )}
          </Button>
        )}

        {/* Loading State */}
        {isLoading && (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin mb-2" />
            <p className="text-sm">Loading land information...</p>
          </div>
        )}

        {/* Land Data */}
        {landData && !isLoading && (
          <>
            <Separator />

            {/* Collapsible Information Sections */}
            <Accordion
              type="multiple"
              defaultValue={["admin", "survey", "lgd"]}
              className="space-y-2"
            >
              {/* Administrative Details */}
              <AccordionItem value="admin" className="border rounded-lg">
                <AccordionTrigger className="px-4 py-3 hover:no-underline">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      Administrative Details
                    </span>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-3">
                  <div className="space-y-3">
                    <InfoRow
                      label="District"
                      value={landData.dname}
                      code={landData.district_code}
                    />
                    <InfoRow
                      label="Taluk"
                      value={landData.tname}
                      code={landData.taluk_code}
                    />
                    <InfoRow
                      label="Village"
                      value={landData.vname}
                      code={landData.village_code}
                    />
                  </div>
                </AccordionContent>
              </AccordionItem>

              {/* Survey Information */}
              <AccordionItem value="survey" className="border rounded-lg">
                <AccordionTrigger className="px-4 py-3 hover:no-underline">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      Survey Information
                    </span>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-3">
                  <div className="space-y-3">
                    <InfoRow
                      label="Survey Number"
                      value={getDisplaySurveyNumber(landData)}
                    />
                    <InfoRow
                      label="Sub Division"
                      value={landData.sub_division || "N/A"}
                    />
                    <InfoRow label="KIDE" value={landData.kide} />
                  </div>
                </AccordionContent>
              </AccordionItem>

              {/* LGD Codes */}
              <AccordionItem value="lgd" className="border rounded-lg">
                <AccordionTrigger className="px-4 py-3 hover:no-underline">
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">LGD Codes</span>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-3">
                  <div className="bg-muted/30 p-2 rounded">
                    <span className="text-muted-foreground block text-xs">
                      Village LGD Code
                    </span>
                    <span className="font-mono text-sm">
                      {landData.lgd_village_code}
                    </span>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            {/* Download EC Button */}
            <div className="flex gap-2">
              <Button
                onClick={downloadEC}
                variant="secondary"
                className="flex-1"
                disabled={isDownloading}
              >
                {isDownloading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Downloading...
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4 mr-2" />
                    Download EC
                  </>
                )}
              </Button>

              {pdfPath && (
                <Button
                  onClick={() => setShowPdfDialog(true)}
                  variant="outline"
                  className="flex-1"
                >
                  <Eye className="h-4 w-4 mr-2" />
                  View PDF
                </Button>
              )}
            </div>

            {/* Refetch Button */}
            <Button
              onClick={fetchLandInfo}
              variant="outline"
              className="w-full"
              disabled={isLoading}
            >
              <Search className="h-4 w-4 mr-2" />
              Refetch Details
            </Button>
          </>
        )}

        {/* No Data State */}
        {hasFetched && !landData && !isLoading && (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-8">
              <Map className="h-12 w-12 text-muted-foreground/50 mb-2" />
              <p className="text-sm text-muted-foreground text-center">
                No land data found for this location
              </p>
              <Button
                onClick={fetchLandInfo}
                variant="outline"
                size="sm"
                className="mt-4"
              >
                Try Again
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      {/* PDF Preview Dialog */}
      <Dialog open={showPdfDialog} onOpenChange={setShowPdfDialog}>
        <DialogContent className="max-w-4xl h-[90vh]">
          <DialogHeader>
            <DialogTitle>EC Document Preview</DialogTitle>
          </DialogHeader>
          <div className="h-[calc(90vh-80px)] w-full">
            {pdfPath && (
              <iframe
                src={`${API_URL}/files${pdfPath.split("outputs")[1]}#navpanes=0`}
                className="w-full h-full border rounded"
                title="PDF Preview"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const InfoRow = ({
  label,
  value,
  code,
}: {
  label: string;
  value: string | number;
  code?: string | number;
}) => (
  <div className="flex justify-between items-center">
    <span className="text-sm text-muted-foreground">{label}</span>
    <div className="text-right">
      <span className="text-sm font-medium text-card-foreground">{value}</span>
      {code !== undefined && (
        <span className="text-xs text-muted-foreground ml-1">({code})</span>
      )}
    </div>
  </div>
);

export default InfoSidebar;
