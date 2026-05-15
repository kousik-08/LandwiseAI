import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import Index from "./pages/Index";
import MapPage from "./pages/MapPage";
import LandingPage from "./pages/LandingPage";
import HierarchyPage from "./pages/HierarchyPage";
import LegalDashboard from "./pages/LegalDashboard";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import NotFound from "./pages/NotFound";
import { AuthProvider } from "./context/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";
import PageTransition from "./components/PageTransition";
import AppShell from "./components/AppShell";

const queryClient = new QueryClient();

// Wrap protected routes in the persistent app shell so navigation, breadcrumbs
// and the user menu remain visible across the workspace. Canvas-style pages
// (map, hierarchy graph) get fullBleed so the header overlays without
// reserving vertical space.
const Shell = ({ children, fullBleed = false }: { children: React.ReactNode; fullBleed?: boolean }) => (
  <ProtectedRoute>
    <AppShell fullBleed={fullBleed}>
      <PageTransition>{children}</PageTransition>
    </AppShell>
  </ProtectedRoute>
);

const AnimatedRoutes = () => {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <Routes location={location} key={location.pathname}>
        <Route
          path="/login"
          element={
            <PageTransition>
              <LoginPage />
            </PageTransition>
          }
        />
        <Route
          path="/signup"
          element={
            <PageTransition>
              <SignupPage />
            </PageTransition>
          }
        />

        <Route path="/" element={<Shell><LandingPage /></Shell>} />
        <Route path="/map" element={<Shell fullBleed><MapPage /></Shell>} />
        <Route path="/verify" element={<Shell><Index /></Shell>} />
        <Route path="/hierarchy" element={<Shell fullBleed><HierarchyPage /></Shell>} />
        <Route path="/dashboard" element={<Shell><LegalDashboard /></Shell>} />

        <Route
          path="*"
          element={
            <PageTransition>
              <NotFound />
            </PageTransition>
          }
        />
      </Routes>
    </AnimatePresence>
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner position="top-right" richColors />
        <BrowserRouter>
          <AnimatedRoutes />
        </BrowserRouter>
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
