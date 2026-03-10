import React from "react";

const Navbar = () => {
  return (
    <nav className="fixed top-0 left-0 right-0 h-16 bg-card border-b border-border z-[1001] shadow-sm">
      <div className="h-full px-6 flex items-center">
        <div className="flex items-center gap-3">
          <img src="/data-flow.png" alt="Pattaflow Logo" className="h-8 w-8" />
          <span className="text-xl font-semibold text-foreground">
            Pattaflow
          </span>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
