import React from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import {
  LayoutDashboard,
  Upload,
  GitBranch,
  Map as MapIcon,
  ChevronRight,
  LogOut,
  User as UserIcon,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface AppShellProps {
  children: React.ReactNode;
  /** When true, the shell is fixed-position and the page renders edge-to-edge under it
   * (used by canvas-style pages like the map and hierarchy graph). */
  fullBleed?: boolean;
}

const NAV_ITEMS: { label: string; to: string; icon: typeof LayoutDashboard; matchPaths?: string[] }[] = [
  { label: "Workspace", to: "/", icon: LayoutDashboard, matchPaths: ["/", "/dashboard"] },
  { label: "Verify", to: "/verify", icon: Upload },
  { label: "Hierarchy", to: "/hierarchy", icon: GitBranch },
  { label: "Map", to: "/map", icon: MapIcon },
];

const HUMAN_LABEL: Record<string, string> = {
  "": "Workspace",
  verify: "Verify Documents",
  hierarchy: "Title Hierarchy",
  map: "Land Map",
  dashboard: "Legal Workspace",
};

const AppShell: React.FC<AppShellProps> = ({ children, fullBleed = false }) => {
  const { user, logout } = useAuth();
  const location = useLocation();

  const segments = location.pathname.split("/").filter(Boolean);
  const crumbs = [
    { label: "Workspace", href: "/" },
    ...segments.map((seg, i) => ({
      label: HUMAN_LABEL[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1),
      href: "/" + segments.slice(0, i + 1).join("/"),
    })),
  ];

  const initials = user?.full_name
    ? user.full_name.split(" ").map(p => p[0]).join("").slice(0, 2).toUpperCase()
    : "?";

  return (
    <div className={cn("min-h-screen flex flex-col bg-background", fullBleed && "h-screen overflow-hidden")}>
      <motion.header
        initial={{ y: -16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          "border-b border-border bg-white/85 backdrop-blur-md z-50 shrink-0",
          fullBleed ? "fixed top-0 left-0 right-0" : "sticky top-0",
        )}
      >
        <div className="px-4 sm:px-6 py-2.5 flex items-center gap-4">
          {/* Brand */}
          <Link to="/" className="flex items-center gap-2 group shrink-0">
            <img
              src="/data-flow.png"
              alt="LandwiseAI"
              className="h-7 w-7 transition-transform group-hover:rotate-6"
            />
            <span className="hidden sm:block text-base font-display font-extrabold tracking-tight text-foreground">
              Land<span className="text-gradient-primary">wiseAI</span>
            </span>
          </Link>

          {/* Primary nav */}
          <nav className="flex items-center gap-1 bg-slate-100/60 p-1 rounded-full border border-slate-200/60">
            {NAV_ITEMS.map(item => {
              const Icon = item.icon;
              const matches = item.matchPaths
                ? item.matchPaths.some(p => p === location.pathname)
                : location.pathname.startsWith(item.to);
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider transition-all",
                    matches
                      ? "bg-white text-primary shadow-sm border border-slate-200/80"
                      : "text-slate-500 hover:text-primary",
                  )}
                  title={item.label}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span className="hidden md:inline">{item.label}</span>
                </NavLink>
              );
            })}
          </nav>

          {/* Spacer */}
          <div className="flex-1" />

          {/* User menu */}
          {user && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex items-center gap-2 px-2 py-1 rounded-full hover:bg-slate-100 transition-colors"
                  title={user.full_name}
                >
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary to-indigo-600 text-white text-[10px] font-bold flex items-center justify-center">
                    {initials}
                  </div>
                  <span className="hidden lg:block text-xs font-bold text-slate-700 max-w-[140px] truncate">
                    {user.full_name}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel className="flex flex-col gap-0.5">
                  <span className="text-sm font-bold text-slate-900">{user.full_name}</span>
                  <span className="text-[10px] text-slate-500 font-mono">{user.email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/dashboard" className="cursor-pointer flex items-center gap-2">
                    <UserIcon className="w-3.5 h-3.5" /> Legal Workspace
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => logout()}
                  className="cursor-pointer text-red-600 focus:text-red-700 focus:bg-red-50 flex items-center gap-2"
                >
                  <LogOut className="w-3.5 h-3.5" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Breadcrumb (hidden when only one crumb i.e. on workspace root) */}
        {!fullBleed && crumbs.length > 1 && (
          <div className="px-4 sm:px-6 pb-2 -mt-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400 overflow-x-auto custom-scrollbar">
            {crumbs.map((c, i) => (
              <React.Fragment key={c.href + i}>
                {i > 0 && <ChevronRight className="w-3 h-3 text-slate-300 shrink-0" />}
                {i === crumbs.length - 1 ? (
                  <span className="text-primary">{c.label}</span>
                ) : (
                  <Link to={c.href} className="hover:text-primary transition-colors">
                    {c.label}
                  </Link>
                )}
              </React.Fragment>
            ))}
          </div>
        )}
      </motion.header>

      {/* Main content. fullBleed adds top padding so fixed header doesn't overlap. */}
      <main className={cn("flex-1 min-h-0", fullBleed && "pt-14 h-full overflow-hidden")}>
        {children}
      </main>
    </div>
  );
};

export default AppShell;
