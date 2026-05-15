import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { 
  ChevronRight, Users, Monitor, Database, 
  Search, ShieldAlert, Scale, ClipboardCheck, 
  FileSignature, CheckCircle2, History, MessageSquare, 
  LayoutDashboard, Map as MapIcon, Library, LogOut,
  ArrowRight, Plus, MapPin, Calendar, Briefcase,
  Building, Home, TreePine, Factory, HardHat, 
  GanttChart, Landmark, CalendarIcon
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { landwiseApi } from "@/lib/landwise-api";
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogDescription,
  DialogFooter,
  DialogTrigger
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarUI } from "@/components/ui/calendar";
import { format } from "date-fns";

interface Project {
  id: string;
  name: string;
  description: string;
  district: string;
  state?: string;
  status?: string;
  target_acquisition_date?: string;
}

const LandingPage = () => {
  const [activePhase, setActivePhase] = useState(1);
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [targetDate, setTargetDate] = useState<Date | undefined>(undefined);
  const [newProject, setNewProject] = useState({ 
    name: "", 
    district: "", 
    description: "",
    state: "Tamil Nadu",
    project_type: "Land Acquisition",
    project_icon: "building",
    legal_advisor_id: ""
  });

  const { data: advisorsData } = useQuery<any[]>({
    queryKey: ['legal-advisors'],
    queryFn: landwiseApi.listLegalAdvisors,
    enabled: isCreateModalOpen
  });

  const advisors = (advisorsData as any[]) || [];

  const projectTypes = [
    { value: "Land Acquisition", label: "Land Acquisition" },
    { value: "Title Diligence", label: "Title Diligence" },
    { value: "Development Project", label: "Development Project" },
    { value: "Industrial Setup", label: "Industrial Setup" },
    { value: "Residential Layout", label: "Residential Layout" },
    { value: "Litigation Portfolio", label: "Litigation Portfolio" }
  ];

  const icons = [
    { id: "building", icon: Building, color: "text-blue-500" },
    { id: "home", icon: Home, color: "text-indigo-500" },
    { id: "tree", icon: TreePine, color: "text-green-500" },
    { id: "factory", icon: Factory, color: "text-slate-500" },
    { id: "hardhat", icon: HardHat, color: "text-amber-500" },
    { id: "scale", icon: Scale, color: "text-purple-500" },
    { id: "landmark", icon: Landmark, color: "text-orange-500" },
    { id: "gantt", icon: GanttChart, color: "text-teal-500" }
  ];

  const { data: projectsData, isLoading: projectsLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: landwiseApi.getProjects,
    enabled: !!user
  });

  const createProjectMutation = useMutation({
    mutationFn: landwiseApi.createProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setIsCreateModalOpen(false);
      setNewProject({ 
        name: "", 
        district: "", 
        description: "",
        state: "Tamil Nadu",
        project_type: "Land Acquisition",
        project_icon: "building",
        legal_advisor_id: ""
      });
      setTargetDate(undefined);
      toast.success("Project created successfully");
    },
    onError: () => toast.error("Failed to create project")
  });

  const handleCreateProject = () => {
    if (!newProject.name || !newProject.district) {
      toast.error("Please fill in required fields");
      return;
    }
    const payload = {
      ...newProject,
      target_acquisition_date: targetDate ? format(targetDate, "yyyy-MM-dd") : null
    };
    createProjectMutation.mutate(payload);
  };

  const projects = projectsData?.data || [];

  const phases = [
    {
      id: 1,
      title: "Onboarding & Setup",
      subtitle: "Project created, parcels registered, team assigned",
      icon: <Users className="w-5 h-5" />,
      color: "#1A3FD4",
      bg: "#EBF0FF",
      actors: ["Portfolio Manager", "System"],
      steps: [
        { title: "Create Project", desc: "Set name, geographic scope, and target acquisition timeline." },
        { title: "Register Parcels", desc: "Input survey numbers, taluk, village, and area details." },
        { title: "Assign Team", desc: "Allocate Legal Advisor and Site Manager to the project." }
      ]
    },
    {
      id: 2,
      title: "Document Upload",
      subtitle: "Site Manager organizes physical documents into folders",
      icon: <Library className="w-5 h-5" />,
      color: "#0A6E47",
      bg: "#E4F5EE",
      actors: ["Site Manager", "System"],
      steps: [
        { title: "Vault Navigation", desc: "Use the folder tree tree: Project → Site → Survey Number." },
        { title: "Upload Scans", desc: "Drag-and-drop PDFs/images and tag by document type and year." },
        { title: "Track Progress", desc: "Monitor upload completeness and missing required document types." }
      ]
    },
    {
      id: 3,
      title: "AI Field Extraction",
      subtitle: "LLM-powered OCR transforms scans into structured data",
      icon: <Database className="w-5 h-5" />,
      color: "#4B1FA8",
      bg: "#EDE9FF",
      actors: ["AI / System"],
      steps: [
        { title: "OCR Processing", desc: "Support for Tamil/English bilingual text recognition." },
        { title: "Field Mapping", desc: "Extract names, survey numbers, amounts, and dates automatically." },
        { title: "Confidence Scoring", desc: "AI provides accuracy scores for lawyer verification." }
      ]
    },
    {
      id: 4,
      title: "Document Review",
      subtitle: "Lawyers annotate and verify extracted data points",
      icon: <Scale className="w-5 h-5" />,
      color: "#1A3FD4",
      bg: "#EBF0FF",
      actors: ["Legal Advisor"],
      steps: [
        { title: "3-Column Workspace", desc: "View PDF, verify fields, and monitor risk flags simultaneously." },
        { title: "Annotations", desc: "Color-code and underline critical clauses for the final opinion." },
        { title: "Verification", desc: "Override and lock AI-extracted fields for truth source." }
      ]
    },
    {
      id: 5,
      title: "Risk Analysis",
      subtitle: "Severity-coded risk flagging and escalation system",
      icon: <ShieldAlert className="w-5 h-5" />,
      color: "#8B1A1A",
      bg: "#FEE8E8",
      actors: ["Legal Advisor", "Portfolio Manager"],
      steps: [
        { title: "Severity Tagging", desc: "Identify Low, Medium, High, and Critical title defects." },
        { title: "Decision Engine", desc: "Accept, Dismiss, or Escalate risks to the Manager." },
        { title: "Resolution Logs", desc: "Immutable trail of how each risk was mitigated or verified." }
      ]
    },
    {
      id: 6,
      title: "Cross-Doc Comparison",
      subtitle: "Detecting mismatches in names, areas, or boundaries",
      icon: <Search className="w-5 h-5" />,
      color: "#A05A00",
      bg: "#FEF3E2",
      actors: ["AI / Legal Advisor"],
      steps: [
        { title: "Side-by-Side View", desc: "Compare two documents synchronously to find discrepancies." },
        { title: "Auto-Mismatch", desc: "System highlights differences in area between EC and Sale Deeds." },
        { title: "Consistency Guard", desc: "Ensures legal chain continuity across the 30-year span." }
      ]
    },
    {
      id: 7,
      title: "Property History",
      subtitle: "30-year ownership and encumbrance timeline",
      icon: <History className="w-5 h-5" />,
      color: "#4B1FA8",
      bg: "#EDE9FF",
      actors: ["System", "Legal Advisor"],
      steps: [
        { title: "Visual Timeline", desc: "Interactive graph of ownership transfers and mutations." },
        { title: "Encumbrance Log", desc: "Track mortgages and their subsequent discharges over time." },
        { title: "Gap Detection", desc: "Highlight missing years or unclear transfer sequences." }
      ]
    },
    {
      id: 8,
      title: "Checklist Verification",
      subtitle: "Gated verification process across 5 key legal phases",
      icon: <ClipboardCheck className="w-5 h-5" />,
      color: "#0A6E47",
      bg: "#E4F5EE",
      actors: ["Legal Advisor"],
      steps: [
        { title: "Binary Verdicts", desc: "Mark items as Clear, Caution, or Fail to gate the opinion." },
        { title: "Mandatory Checks", desc: "Ensures critical legal statutes are addressed before closing." },
        { title: "Audit Link", desc: "Each item links back to the supporting document evidence." }
      ]
    },
    {
      id: 9,
      title: "Opinion Drafting",
      subtitle: "Assembling the final legal title report",
      icon: <MessageSquare className="w-5 h-5" />,
      color: "#1A3FD4",
      bg: "#EBF0FF",
      actors: ["AI Legal Bot", "Legal Advisor"],
      steps: [
        { title: "Section Builder", desc: "Auto-generate sections based on checklist findings." },
        { title: "AI Assistant", desc: "Consult the AI bit for Madras High Court precedents." },
        { title: "Verdict Setting", desc: "Set final status: Safe / Proceed with Caution / Do Not Proceed." }
      ]
    },
    {
      id: 10,
      title: "Digital Sign & Sign-off",
      subtitle: "Finalizing the legal output and notifying teams",
      icon: <FileSignature className="w-5 h-5" />,
      color: "#0A6E47",
      bg: "#E4F5EE",
      actors: ["Legal Advisor", "Portfolio Manager"],
      steps: [
        { title: "Lock & Seal", desc: "Digital signature locks the opinion from further editing." },
        { title: "Report Generation", desc: "PDF export of the professional title opinion report." },
        { title: "Final Status", desc: "Parcel status updates to 'Completed' in the portfolio dashboard." }
      ]
    }
  ];

  return (
    <div className="min-h-screen bg-[#F0F3F8] flex flex-col font-sans text-[#0C1829]">
      {/* Header */}
      <motion.header
        initial={{ y: -32, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="relative bg-gradient-to-r from-[#1A3FD4] via-[#1737B8] to-[#0F2A8F] text-white p-4 sm:p-6 sticky top-0 z-50 shadow-lg overflow-hidden"
      >
        {/* Animated aurora overlay */}
        <div className="pointer-events-none absolute inset-0 opacity-30 mix-blend-overlay">
          <div className="absolute -top-32 -left-20 w-96 h-96 rounded-full bg-blue-400/40 blur-3xl animate-blob-slow" />
          <div className="absolute -bottom-40 right-10 w-96 h-96 rounded-full bg-indigo-300/40 blur-3xl animate-blob" />
        </div>
        <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-3 flex-wrap relative">
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl lg:text-2xl font-extrabold tracking-tight flex items-center gap-2 flex-wrap">
              <motion.span
                initial={{ rotate: -20, scale: 0.6, opacity: 0 }}
                animate={{ rotate: 0, scale: 1, opacity: 1 }}
                transition={{ delay: 0.15, duration: 0.6, ease: [0.34, 1.56, 0.64, 1] }}
                className="inline-flex"
              >
                <Scale className="w-5 h-5 sm:w-6 sm:h-6 text-[#A5B4FC]" />
              </motion.span>
              LandwiseAI <span className="text-[#A5B4FC] font-light hidden sm:inline">| Legal Command Center</span>
            </h1>
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 0.85, y: 0 }}
              transition={{ delay: 0.25, duration: 0.4 }}
              className="hidden sm:flex items-center gap-3 lg:gap-4 mt-1 text-[10px] sm:text-[11px] uppercase tracking-wider font-semibold flex-wrap"
            >
              <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {user?.full_name}</span>
              <span className="flex items-center gap-1 font-bold"><ShieldAlert className="w-3 h-3" /> {user?.role}</span>
              <span className="hidden md:flex items-center gap-1"><MapIcon className="w-3 h-3" /> Tamil Nadu Regulations</span>
            </motion.div>
          </div>
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2, duration: 0.4 }}
            className="flex items-center gap-2 sm:gap-3 shrink-0"
          >
             <Button
                variant="ghost"
                size="sm"
                className="text-white hover:bg-white/10 transition-transform hover:scale-105 px-2 sm:px-3"
                onClick={() => navigate("/dashboard")}
              >
                <LayoutDashboard className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">Dashboard</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-white hover:bg-red-500/20 text-red-100 transition-transform hover:scale-105 px-2 sm:px-3"
                onClick={logout}
              >
                <LogOut className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">Logout</span>
              </Button>
          </motion.div>
        </div>
      </motion.header>

      <div className="flex-1 max-w-[1600px] mx-auto w-full flex flex-col min-h-0 bg-white shadow-xl my-4 sm:my-6 lg:my-8 mx-3 sm:mx-6 lg:mx-auto rounded-2xl sm:rounded-3xl overflow-hidden border border-slate-200">
        {user ? (
          <div className="flex flex-col h-full">
            {/* PROJECTS HUB HEADER */}
            <div className="p-5 sm:p-7 lg:p-10 border-b border-slate-100 bg-gradient-to-br from-white to-slate-50/50">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                >
                  <h2 className="text-2xl sm:text-3xl lg:text-4xl font-black tracking-tight text-slate-900">
                    Project <span className="text-gradient-primary">Command Center</span>
                  </h2>
                  <p className="text-sm lg:text-base text-slate-500 mt-2 font-medium">Monitoring {projects.length} active real estate acquisitions across Tamil Nadu.</p>
                </motion.div>
                <Dialog open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen}>
                  <DialogTrigger asChild>
                    <motion.div
                      initial={{ opacity: 0, scale: 0.92 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: 0.1, duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.97 }}
                    >
                      <Button className="bg-[#1A3FD4] hover:bg-[#0F2A8F] text-white px-5 sm:px-8 h-12 sm:h-14 rounded-xl sm:rounded-2xl font-bold shadow-lg shadow-blue-500/30 hover:shadow-xl hover:shadow-blue-500/40 text-sm sm:text-base shine-sweep transition-all">
                        <Plus className="w-4 h-4 sm:w-5 sm:h-5 mr-2 sm:mr-3" />
                        <span className="hidden sm:inline">Initiate New Project</span>
                        <span className="sm:hidden">New Project</span>
                      </Button>
                    </motion.div>
                  </DialogTrigger>
                  <DialogContent className="bg-white border-slate-200 sm:max-w-[600px] rounded-3xl">
                    <DialogHeader>
                      <DialogTitle className="text-2xl font-black text-slate-900">Initiate Project</DialogTitle>
                      <DialogDescription className="text-slate-500 font-medium pt-1">
                        Define a new real-estate project to begin legal auditing.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-5 py-6">
                      {/* Project Name & Type */}
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label className="text-xs font-black uppercase tracking-widest text-slate-500">Project Name</Label>
                          <Input 
                            placeholder="e.g. Green Valley Residency" 
                            className="bg-slate-50 border-slate-200 h-11 rounded-xl focus:ring-blue-500"
                            value={newProject.name}
                            onChange={e => setNewProject({...newProject, name: e.target.value})}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-black uppercase tracking-widest text-slate-500">Project Type</Label>
                          <Select value={newProject.project_type} onValueChange={(val) => setNewProject({...newProject, project_type: val})}>
                            <SelectTrigger className="bg-slate-50 border-slate-200 h-11 rounded-xl">
                              <SelectValue placeholder="Select type" />
                            </SelectTrigger>
                            <SelectContent className="bg-white border-slate-200">
                              {projectTypes.map((type) => (
                                <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {/* District & State */}
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label className="text-xs font-black uppercase tracking-widest text-slate-500">District</Label>
                          <Select value={newProject.district} onValueChange={(val) => setNewProject({...newProject, district: val})}>
                            <SelectTrigger className="bg-slate-50 border-slate-200 h-11 rounded-xl">
                              <SelectValue placeholder="Select district" />
                            </SelectTrigger>
                            <SelectContent className="bg-white border-slate-200">
                              <SelectItem value="Chennai">Chennai</SelectItem>
                              <SelectItem value="Coimbatore">Coimbatore</SelectItem>
                              <SelectItem value="Madurai">Madurai</SelectItem>
                              <SelectItem value="Trichy">Trichy</SelectItem>
                              <SelectItem value="Salem">Salem</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-black uppercase tracking-widest text-slate-500">State</Label>
                          <Select value={newProject.state} onValueChange={(val) => setNewProject({...newProject, state: val})}>
                            <SelectTrigger className="bg-slate-50 border-slate-200 h-11 rounded-xl">
                              <SelectValue placeholder="Select state" />
                            </SelectTrigger>
                            <SelectContent className="bg-white border-slate-200">
                              <SelectItem value="Tamil Nadu">Tamil Nadu</SelectItem>
                              <SelectItem value="Karnataka">Karnataka</SelectItem>
                              <SelectItem value="Kerala">Kerala</SelectItem>
                              <SelectItem value="Andhra Pradesh">Andhra Pradesh</SelectItem>
                              <SelectItem value="Telangana">Telangana</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {/* Legal Advisor & Target Date */}
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label className="text-xs font-black uppercase tracking-widest text-slate-500">Legal Advisor</Label>
                          <Select value={newProject.legal_advisor_id} onValueChange={(val) => setNewProject({...newProject, legal_advisor_id: val})}>
                            <SelectTrigger className="bg-slate-50 border-slate-200 h-11 rounded-xl">
                              <SelectValue placeholder="Select advisor" />
                            </SelectTrigger>
                            <SelectContent className="bg-white border-slate-200">
                              {advisors.map((advisor: any) => (
                                <SelectItem key={advisor.id} value={advisor.id}>{advisor.full_name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-black uppercase tracking-widest text-slate-500">Target Completion Date</Label>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                variant="outline"
                                className={cn(
                                  "w-full bg-slate-50 border-slate-200 h-11 justify-start text-left font-medium rounded-xl",
                                  !targetDate && "text-slate-400"
                                )}
                              >
                                <CalendarIcon className="mr-2 h-4 w-4" />
                                {targetDate ? format(targetDate, "PPP") : <span>Pick a date</span>}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0 bg-white" align="start">
                              <CalendarUI
                                mode="single"
                                selected={targetDate}
                                onSelect={setTargetDate}
                                initialFocus
                              />
                            </PopoverContent>
                          </Popover>
                        </div>
                      </div>

                      {/* Project Icon */}
                      <div className="space-y-3">
                        <Label className="text-xs font-black uppercase tracking-widest text-slate-500">Project Icon</Label>
                        <div className="flex flex-wrap gap-3">
                          {icons.map((item) => {
                            const IconComp = item.icon;
                            return (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => setNewProject({ ...newProject, project_icon: item.id })}
                                className={cn(
                                  "w-10 h-10 rounded-xl flex items-center justify-center border-2 transition-all",
                                  newProject.project_icon === item.id 
                                    ? "bg-indigo-50 border-indigo-500 shadow-sm" 
                                    : "bg-white border-slate-100 hover:border-slate-200"
                                )}
                              >
                                <IconComp className={cn("w-5 h-5", item.color)} />
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Description */}
                      <div className="space-y-2">
                        <Label className="text-xs font-black uppercase tracking-widest text-slate-500">Strategic Description</Label>
                        <Textarea 
                          placeholder="High-level project goals and timelines..." 
                          className="bg-slate-50 border-slate-200 rounded-xl focus:ring-blue-500 min-h-[80px]"
                          value={newProject.description}
                          onChange={e => setNewProject({...newProject, description: e.target.value})}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="ghost" onClick={() => setIsCreateModalOpen(false)} className="text-slate-500 hover:bg-slate-100 font-bold">Cancel</Button>
                      <Button 
                        onClick={handleCreateProject}
                        disabled={createProjectMutation.isPending}
                        className="bg-[#1A3FD4] hover:bg-[#0F2A8F] text-white px-8 h-12 rounded-xl font-bold shadow-lg"
                      >
                        {createProjectMutation.isPending ? "Initiating..." : "Initiate Project"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>

              <motion.div
                className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 lg:gap-6 mt-6 lg:mt-10"
                initial="hidden"
                animate="visible"
                variants={{
                  hidden: {},
                  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.15 } },
                }}
              >
                <SummaryStat icon={<Briefcase className="w-5 h-5" />} label="In Flight" value={projects.length} color="blue" />
                <SummaryStat icon={<MapPin className="w-5 h-5" />} label="Districts" value={new Set(projects.map(p => p.district)).size} color="indigo" />
                <SummaryStat icon={<LayoutDashboard className="w-5 h-5" />} label="Pending" value="82%" color="green" />
                <SummaryStat icon={<ShieldAlert className="w-5 h-5" />} label="High Risk" value="12" color="red" />
              </motion.div>
            </div>

            {/* PROJECTS GRID */}
            <div className="flex-1 p-5 sm:p-7 lg:p-10 overflow-y-auto">
              {projectsLoading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 sm:gap-6 lg:gap-8">
                  {[1,2,3].map(i => (
                    <div
                      key={i}
                      className="h-[280px] rounded-3xl animate-skeleton border border-slate-100"
                      style={{ animationDelay: `${i * 0.1}s` }}
                    />
                  ))}
                </div>
              ) : projects.length > 0 ? (
                <motion.div
                  className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 sm:gap-6 lg:gap-8"
                  initial="hidden"
                  animate="visible"
                  variants={{
                    hidden: {},
                    visible: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
                  }}
                >
                  {projects.map((project: any) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      onClick={() => navigate(`/dashboard?projectId=${project.id}`)}
                    />
                  ))}
                </motion.div>
              ) : (
                <motion.div
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                  className="h-full flex flex-col items-center justify-center text-center py-20 bg-gradient-to-br from-slate-50/80 to-blue-50/40 rounded-3xl border border-dashed border-slate-200"
                >
                  <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center mb-6 shadow-md border border-slate-100 text-slate-400 animate-float">
                    <Library className="w-10 h-10" />
                  </div>
                  <h3 className="text-2xl font-black text-slate-900">Zero Active Projects</h3>
                  <p className="max-w-xs mt-2 text-slate-500 font-medium">Initiate your first project to begin coordinating land acquisition workflows.</p>
                </motion.div>
              )}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[280px_1fr] h-full">
            {/* Sidebar Nav */}
            <aside className="border-r border-[#E0E6EF] bg-white p-6 overflow-y-auto">
          <div className="mb-6">
            <h4 className="text-[10px] font-bold text-[#8A9BB8] uppercase tracking-widest mb-4">Functional Workflow</h4>
            <nav className="space-y-1">
              {phases.map((phase) => (
                <button
                  key={phase.id}
                  onClick={() => setActivePhase(phase.id)}
                  className={`w-full flex items-center gap-3 p-2.5 rounded-lg text-left transition-all group ${
                    activePhase === phase.id 
                    ? "bg-[#EBF0FF] text-[#1A3FD4] shadow-sm ring-1 ring-[#1A3FD4]/20" 
                    : "hover:bg-[#F0F3F8] text-[#4A5A72]"
                  }`}
                >
                  <div className={`w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold shrink-0 ${
                    activePhase === phase.id ? "bg-[#1A3FD4] text-white" : "bg-[#E0E6EF] text-[#8A9BB8]"
                  }`}>
                    {phase.id}
                  </div>
                  <span className={`text-xs font-semibold ${activePhase === phase.id ? "text-[#1A3FD4]" : "text-[#4A5A72]"}`}>
                    {phase.title}
                  </span>
                </button>
              ))}
            </nav>
          </div>
          <div className="pt-6 border-t border-[#F0F3F8]">
            <h4 className="text-[10px] font-bold text-[#8A9BB8] uppercase tracking-widest mb-4">Platform Views</h4>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => navigate("/map")} className="flex flex-col items-center p-3 rounded-xl border border-[#E0E6EF] bg-white hover:bg-[#F0F3F8] hover:border-[#1A3FD4] transition-all group">
                <MapIcon className="w-5 h-5 text-[#4A5A72] group-hover:text-[#1A3FD4] mb-1" />
                <span className="text-[9px] font-bold text-[#4A5A72]">Map View</span>
              </button>
              <button onClick={() => navigate("/dashboard")} className="flex flex-col items-center p-3 rounded-xl border border-[#E0E6EF] bg-white hover:bg-[#F0F3F8] hover:border-[#1A3FD4] transition-all group">
                <LayoutDashboard className="w-5 h-5 text-[#4A5A72] group-hover:text-[#1A3FD4] mb-1" />
                <span className="text-[9px] font-bold text-[#4A5A72]">Workspace</span>
              </button>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="p-10 overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={activePhase}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.3 }}
              className="max-w-4xl"
            >
              <div className="bg-white border border-[#E0E6EF] rounded-2xl shadow-xl overflow-hidden">
                {/* Phase Header */}
                <div 
                  className="p-8 border-b-2 border-[#F0F3F8] flex items-center justify-between"
                  style={{ background: `linear-gradient(135deg, ${phases[activePhase-1].bg}, #fff)` }}
                >
                  <div className="flex items-center gap-5">
                    <div 
                      className="w-14 h-14 rounded-xl flex items-center justify-center text-white text-2xl shadow-lg"
                      style={{ backgroundColor: phases[activePhase-1].color }}
                    >
                      {activePhase}
                    </div>
                    <div>
                      <h2 className="text-2xl font-extrabold tracking-tight">{phases[activePhase-1].title}</h2>
                      <p className="text-[#8A9BB8] text-sm mt-1">{phases[activePhase-1].subtitle}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {phases[activePhase-1].actors.map(actor => (
                      <span 
                        key={actor}
                        className={`text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded-full border ${
                          actor === "Legal Advisor" ? "bg-[#EBF0FF] text-[#1A3FD4] border-[#1A3FD4]" :
                          actor === "Site Manager" ? "bg-[#E4F5EE] text-[#0A6E47] border-[#0A6E47]" :
                          actor === "System" || actor === "AI / System" ? "bg-[#EDE9FF] text-[#4B1FA8] border-[#4B1FA8]" :
                          "bg-[#FEF3E2] text-[#A05A00] border-[#A05A00]"
                        }`}
                      >
                        {actor}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Phase Body */}
                <div className="p-8">
                  <div className="space-y-6">
                    {phases[activePhase-1].steps.map((step, idx) => (
                      <div key={idx} className="flex gap-6 group">
                        <div className="flex flex-col items-center">
                          <div 
                            className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm border-2 transition-all relative z-10"
                            style={{ 
                              borderColor: phases[activePhase-1].color, 
                              color: phases[activePhase-1].color,
                              backgroundColor: phases[activePhase-1].bg 
                            }}
                          >
                            {idx + 1}
                          </div>
                          {idx !== phases[activePhase-1].steps.length - 1 && (
                            <div className="w-1 flex-1 bg-[#E0E6EF] -my-1" />
                          )}
                        </div>
                        <div className="flex-1 pb-8">
                          <div className="bg-[#F8FAFC] border border-[#E0E6EF] rounded-xl p-5 hover:border-[#1A3FD4] hover:shadow-md transition-all group-hover:bg-white">
                            <h3 className="text-base font-bold mb-2">{step.title}</h3>
                            <p className="text-sm text-[#4A5A72] leading-relaxed mb-4">{step.desc}</p>
                            
                            <div className="grid grid-cols-2 gap-4 mt-4">
                              <div className="p-3 bg-white border border-[#E0E6EF] rounded-lg">
                                <h5 className="text-[9px] font-extrabold text-[#8A9BB8] uppercase tracking-wider mb-2">Inputs Required</h5>
                                <div className="text-[11px] text-[#4A5A72] font-semibold flex items-center gap-2 text-primary">
                                  <ChevronRight className="w-3 h-3" />
                                  Structured Metadata
                                </div>
                              </div>
                              <div className="p-3 bg-white border border-[#E0E6EF] rounded-lg">
                                <h5 className="text-[9px] font-extrabold text-[#8A9BB8] uppercase tracking-wider mb-2">System Output</h5>
                                <div className="text-[11px] text-[#4A5A72] font-semibold flex items-center gap-2 text-green-600">
                                  <CheckCircle2 className="w-3 h-3" />
                                  Verified Data Record
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-8 pt-8 border-t border-[#F0F3F8] flex items-center justify-between">
                    <div className="flex items-center gap-4">
                       <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-primary">
                          <LayoutDashboard className="w-5 h-5" />
                       </div>
                       <div>
                         <h4 className="text-sm font-bold">Ready to start this phase?</h4>
                         <p className="text-xs text-[#8A9BB8]">Enter the workspace to process current parcels</p>
                       </div>
                    </div>
                    <Button 
                      className="bg-[#1A3FD4] hover:bg-[#0F2A8F] text-white px-8 h-12 rounded-xl font-bold text-sm shadow-lg shadow-blue-200"
                      onClick={() => {
                        const pid = selectedProject?.id || (projects.length > 0 ? projects[0].id : null);
                        if (pid) navigate(`/dashboard?projectId=${pid}`);
                        else toast.error("Please create a project first");
                      }}
                    >
                      Enter Legal Advisor Workspace
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </div>
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      )}
    </div>

      <footer className="bg-[#0C1829] text-white py-6 sm:py-8 px-5 sm:px-8 lg:px-12 border-t border-[#1e293b]">
        <div className="max-w-[1600px] mx-auto flex flex-col items-center">
            <div className="flex items-center gap-2 mb-4">
              <Scale className="w-5 h-5 text-primary" />
              <span className="text-base font-bold">LandwiseAI</span>
              <span className="text-xs text-[#8A9BB8] ml-2">v3.0.4-stable</span>
            </div>
            <p className="text-[#8A9BB8] text-xs text-center max-w-xl border-t border-white/10 pt-4 mt-2">
              Advanced Real Estate Legal Intelligence System. Registered with TN Reginet and Revenue Department API Protocols. 
              Designed for end-to-end legal title opinion workflows. 
            </p>
            <p className="text-[10px] text-[#4A5A72] mt-4 font-mono">
              &copy; 2026 LANDWISE ARTIFICIAL INTELLIGENCE SYSTEMS LTD. ALL RIGHTS RESERVED.
            </p>
        </div>
      </footer>
    </div>
  );
};

function useCountUp(target: number, duration = 1100) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(target)) return;
    let raf = 0;
    let start: number | null = null;
    const tick = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min((ts - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(eased * target));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

function AnimatedValue({ value }: { value: string | number }) {
  const numeric = typeof value === "number" ? value : parseFloat(String(value));
  const isPercent = typeof value === "string" && value.trim().endsWith("%");
  const isPlainNumber = Number.isFinite(numeric) && (typeof value === "number" || /^\d+%?$/.test(String(value).trim()));
  const animated = useCountUp(isPlainNumber ? numeric : 0);
  if (!isPlainNumber) return <>{value}</>;
  return <>{animated}{isPercent ? "%" : ""}</>;
}

const statItemVariants = {
  hidden: { opacity: 0, y: 18, scale: 0.96 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] } },
};

function SummaryStat({ icon, label, value, color }: { icon: React.ReactNode, label: string, value: string | number, color: string }) {
  const colors: Record<string, string> = {
    blue: "text-blue-600 bg-blue-50",
    indigo: "text-indigo-600 bg-indigo-50",
    green: "text-green-600 bg-green-50",
    red: "text-red-600 bg-red-50"
  };
  const ringColors: Record<string, string> = {
    blue: "hover:shadow-blue-100",
    indigo: "hover:shadow-indigo-100",
    green: "hover:shadow-green-100",
    red: "hover:shadow-red-100",
  };
  return (
    <motion.div
      variants={statItemVariants}
      whileHover={{ y: -4 }}
      className={cn(
        "relative bg-white border border-slate-100 rounded-xl sm:rounded-2xl p-3 sm:p-4 lg:p-5 flex items-center gap-3 sm:gap-4 shadow-sm overflow-hidden transition-shadow hover:shadow-xl min-w-0",
        ringColors[color]
      )}
    >
      <div className={cn("w-10 h-10 sm:w-12 sm:h-12 rounded-lg sm:rounded-xl flex items-center justify-center transition-transform duration-500 group-hover:rotate-6 shrink-0", colors[color])}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[9px] sm:text-[10px] font-black text-slate-400 uppercase tracking-[0.16em] sm:tracking-widest truncate">{label}</p>
        <h4 className="text-lg sm:text-xl font-black text-slate-900 tabular-nums">
          <AnimatedValue value={value} />
        </h4>
      </div>
    </motion.div>
  );
}

const projectItemVariants = {
  hidden: { opacity: 0, y: 24, scale: 0.96 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } },
};

function ProjectCard({ project, onClick }: { project: Project, onClick: () => void }) {
  return (
    <motion.div
      variants={projectItemVariants}
      whileHover={{ y: -8 }}
      whileTap={{ scale: 0.985 }}
      transition={{ type: "spring", stiffness: 320, damping: 22 }}
      className="relative bg-white border border-slate-200 rounded-2xl sm:rounded-3xl p-5 sm:p-7 lg:p-8 hover:border-[#1A3FD4] hover:shadow-2xl hover:shadow-blue-900/10 transition-all cursor-pointer group flex flex-col h-full overflow-hidden"
      onClick={onClick}
    >
      {/* Hover gradient sheen */}
      <div className="pointer-events-none absolute -top-24 -right-24 w-56 h-56 rounded-full bg-gradient-to-br from-blue-200/0 via-blue-100/0 to-indigo-200/0 group-hover:from-blue-200/40 group-hover:via-blue-100/30 group-hover:to-indigo-200/40 blur-3xl transition-all duration-700" />
      {/* Top edge highlight on hover */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-[#1A3FD4]/0 to-transparent group-hover:via-[#1A3FD4]/60 transition-all duration-500" />

      <div className="flex items-start justify-between mb-8 relative">
        <div className="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center border border-slate-100 group-hover:bg-[#EBF0FF] group-hover:border-[#1A3FD4]/30 group-hover:scale-110 group-hover:rotate-3 transition-all duration-500">
          <Briefcase className="w-7 h-7 text-[#1A3FD4]" />
        </div>
        <Badge className="bg-green-50 text-green-700 hover:bg-green-50 border-green-200 font-black text-[10px] px-3 h-6 uppercase tracking-wider relative">
          <span className="absolute -left-1 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse-glow" />
          <span className="ml-2">{project.status || "Active"}</span>
        </Badge>
      </div>

      <div className="flex-1 relative">
        <h3 className="text-xl font-black text-slate-900 mb-2 truncate group-hover:text-[#1A3FD4] transition-colors">{project.name}</h3>
        <p className="text-slate-500 text-sm font-medium line-clamp-2 min-h-[40px] mb-6">{project.description || "No project description provided."}</p>

        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs font-bold text-slate-700">
            <MapPin className="w-3.5 h-3.5 text-slate-400 group-hover:text-[#1A3FD4] transition-colors" />
            {project.district}, {project.state || "Tamil Nadu"}
          </div>
          <div className="flex items-center gap-2 text-xs font-bold text-slate-700">
            <Calendar className="w-3.5 h-3.5 text-slate-400 group-hover:text-[#1A3FD4] transition-colors" />
            Target: {project.target_acquisition_date || "Not Set"}
          </div>
        </div>
      </div>

      <div className="mt-8 pt-6 border-t border-slate-100 flex items-center justify-between relative">
        <div className="flex -space-x-2">
          {[1,2,3].map(i => (
            <div
              key={i}
              className="w-8 h-8 rounded-full bg-slate-100 border-2 border-white flex items-center justify-center text-[10px] font-black text-slate-400 transition-transform duration-300 group-hover:translate-y-[-2px]"
              style={{ transitionDelay: `${i * 40}ms` }}
            >
              U{i}
            </div>
          ))}
          <div className="w-8 h-8 rounded-full bg-blue-50 border-2 border-white flex items-center justify-center text-[10px] font-black text-blue-600 transition-transform duration-300 group-hover:translate-y-[-2px]" style={{ transitionDelay: "160ms" }}>
            +4
          </div>
        </div>
        <div className="flex items-center gap-2 text-[#1A3FD4] font-black text-xs uppercase tracking-widest opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300">
          Open Workspace
          <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
        </div>
      </div>
    </motion.div>
  );
}

export default LandingPage;
