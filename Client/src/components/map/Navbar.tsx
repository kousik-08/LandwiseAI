import React from "react";
import { motion } from "framer-motion";

const Navbar = () => {
  return (
    <motion.nav
      initial={{ y: -32, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      className="fixed top-0 left-0 right-0 h-16 bg-card/90 backdrop-blur-md border-b border-border z-[1001] shadow-sm"
    >
      <div className="h-full px-6 flex items-center">
        <motion.div
          className="flex items-center gap-3"
          whileHover={{ scale: 1.02 }}
        >
          <motion.img
            src="/data-flow.png"
            alt="LandwiseAI Logo"
            className="h-8 w-8"
            initial={{ rotate: -25, scale: 0.6, opacity: 0 }}
            animate={{ rotate: 0, scale: 1, opacity: 1 }}
            transition={{ delay: 0.1, duration: 0.6, ease: [0.34, 1.56, 0.64, 1] }}
            whileHover={{ rotate: 12, scale: 1.1 }}
          />
          <span className="text-xl font-semibold text-foreground">
            Land<span className="text-gradient-primary">wiseAI</span>
          </span>
        </motion.div>
      </div>
    </motion.nav>
  );
};

export default Navbar;
