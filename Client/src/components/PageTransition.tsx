import { motion } from "framer-motion";
import { ReactNode } from "react";

interface PageTransitionProps {
  children: ReactNode;
}

const variants = {
  initial: { opacity: 0, y: 12, filter: "blur(6px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit:    { opacity: 0, y: -8, filter: "blur(4px)" },
};

export default function PageTransition({ children }: PageTransitionProps) {
  return (
    <motion.div
      initial="initial"
      animate="animate"
      exit="exit"
      variants={variants}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      style={{ minHeight: "100%" }}
    >
      {children}
    </motion.div>
  );
}
