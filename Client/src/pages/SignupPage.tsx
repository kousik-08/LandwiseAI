import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { LockKeyhole, Mail, User, ShieldCheck, Check, X, ArrowRight, LogIn } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

const SignupPage = () => {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("legal_advisor");
  const [loading, setLoading] = useState(false);
  const { signup } = useAuth();
  const navigate = useNavigate();

  const passwordRequirements = [
    { label: "At least 8 characters", met: password.length >= 8 },
    { label: "Contains uppercase", met: /[A-Z]/.test(password) },
    { label: "Contains lowercase", met: /[a-z]/.test(password) },
    { label: "Contains number", met: /\d/.test(password) },
    { label: "Contains special character", met: /[!@#$%^&*(),.?":{}|<>]/.test(password) },
  ];

  const isPasswordStrong = passwordRequirements.every((req) => req.met);
  const metCount = passwordRequirements.filter((r) => r.met).length;
  const strengthPct = (metCount / passwordRequirements.length) * 100;
  const strengthColor =
    metCount <= 1 ? "bg-red-400" :
    metCount === 2 ? "bg-orange-400" :
    metCount === 3 ? "bg-amber-400" :
    metCount === 4 ? "bg-blue-400" : "bg-emerald-500";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isPasswordStrong) return;

    setLoading(true);
    try {
      await signup(fullName, email, password, role);
      navigate("/login");
    } catch (error) {
      // Error is handled in AuthContext
    } finally {
      setLoading(false);
    }
  };

  const containerVariants = {
    hidden: {},
    visible: { transition: { staggerChildren: 0.07, delayChildren: 0.1 } },
  };
  const itemVariants = {
    hidden: { opacity: 0, y: 14 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } },
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#F0F3F8] via-[#EEF2FF] to-[#F0F3F8] p-4 font-sans text-[#0C1829] relative overflow-hidden">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-[15%] -right-[10%] w-[45%] h-[45%] bg-primary/15 rounded-full blur-[120px] animate-blob" />
        <div className="absolute -bottom-[15%] -left-[10%] w-[45%] h-[45%] bg-emerald-300/15 rounded-full blur-[120px] animate-blob-slow" />
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #0C1829 1px, transparent 1px), linear-gradient(to bottom, #0C1829 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
      </div>

      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        className="w-full max-w-lg z-10"
      >
        <motion.div variants={itemVariants} className="flex flex-col items-center mb-6">
          <motion.div
            initial={{ scale: 0.5, rotate: 12, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ duration: 0.7, ease: [0.34, 1.56, 0.64, 1] }}
            className="w-16 h-16 bg-gradient-to-br from-primary to-blue-700 rounded-2xl flex items-center justify-center shadow-xl shadow-blue-500/30 mb-4 relative"
          >
            <div className="absolute inset-0 rounded-2xl bg-primary/40 blur-xl -z-10 animate-pulse-glow" />
            <ShieldCheck className="text-white w-8 h-8" />
          </motion.div>
          <h1 className="text-3xl font-extrabold tracking-tight text-[#0C1829]">
            Create <span className="text-gradient-primary">Account</span>
          </h1>
          <p className="text-[#8A9BB8] text-sm mt-2">Join the LandwiseAI intelligence network</p>
        </motion.div>

        <motion.div variants={itemVariants}>
          <Card className="border-[#E0E6EF] shadow-2xl bg-white/80 backdrop-blur-xl hover:shadow-blue-500/10 transition-shadow duration-500">
            <CardHeader className="space-y-1">
              <CardTitle className="text-xl font-bold">Registration</CardTitle>
              <CardDescription className="text-[#4A5A72]">
                Set up your professional profile and credentials
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <motion.div variants={itemVariants} className="space-y-2">
                    <Label htmlFor="fullName" className="text-sm font-semibold text-[#4A5A72]">Full Name</Label>
                    <div className="relative group focus-glow rounded-md">
                      <User className="absolute left-3 top-3 h-4 w-4 text-[#8A9BB8] group-focus-within:text-primary transition-colors" />
                      <Input
                        id="fullName"
                        placeholder="John Doe"
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        required
                        className="pl-10 bg-[#F0F3F8] border-[#E0E6EF] h-11 focus:border-primary"
                      />
                    </div>
                  </motion.div>
                  <motion.div variants={itemVariants} className="space-y-2">
                    <Label htmlFor="role" className="text-sm font-semibold text-[#4A5A72]">Internal Role</Label>
                    <Select value={role} onValueChange={setRole}>
                      <SelectTrigger className="bg-[#F0F3F8] border-[#E0E6EF] h-11 focus:border-primary">
                        <SelectValue placeholder="Select role" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="legal_advisor">Legal Advisor</SelectItem>
                        <SelectItem value="portfolio_manager">Portfolio Manager</SelectItem>
                      </SelectContent>
                    </Select>
                  </motion.div>
                </div>

                <motion.div variants={itemVariants} className="space-y-2">
                  <Label htmlFor="email" className="text-sm font-semibold text-[#4A5A72]">Email address</Label>
                  <div className="relative group focus-glow rounded-md">
                    <Mail className="absolute left-3 top-3 h-4 w-4 text-[#8A9BB8] group-focus-within:text-primary transition-colors" />
                    <Input
                      id="email"
                      type="email"
                      placeholder="name@company.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="pl-10 bg-[#F0F3F8] border-[#E0E6EF] h-11 focus:border-primary"
                    />
                  </div>
                </motion.div>

                <motion.div variants={itemVariants} className="space-y-2">
                  <Label htmlFor="password" className="text-sm font-semibold text-[#4A5A72]">Secure Password</Label>
                  <div className="relative group focus-glow rounded-md">
                    <LockKeyhole className="absolute left-3 top-3 h-4 w-4 text-[#8A9BB8] group-focus-within:text-primary transition-colors" />
                    <Input
                      id="password"
                      type="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      className="pl-10 bg-[#F0F3F8] border-[#E0E6EF] h-11 focus:border-primary"
                    />
                  </div>

                  {/* Strength meter */}
                  <div className="mt-3 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                    <motion.div
                      className={`h-full rounded-full ${strengthColor}`}
                      initial={{ width: 0 }}
                      animate={{ width: `${strengthPct}%` }}
                      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                    />
                  </div>

                  <div className="p-3 bg-[#F8FAFC] rounded-lg border border-[#E0E6EF] grid grid-cols-2 gap-2 mt-2">
                    {passwordRequirements.map((req, idx) => (
                      <motion.div
                        key={idx}
                        layout
                        className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider"
                      >
                        <AnimatePresence mode="wait" initial={false}>
                          {req.met ? (
                            <motion.span
                              key="met"
                              initial={{ scale: 0, rotate: -90, opacity: 0 }}
                              animate={{ scale: 1, rotate: 0, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                              transition={{ duration: 0.3, ease: [0.34, 1.56, 0.64, 1] }}
                              className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-100"
                            >
                              <Check className="h-2.5 w-2.5 text-[#0A6E47]" strokeWidth={3} />
                            </motion.span>
                          ) : (
                            <motion.span
                              key="unmet"
                              initial={{ scale: 0.7, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0.7, opacity: 0 }}
                              transition={{ duration: 0.2 }}
                              className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-slate-100"
                            >
                              <X className="h-2.5 w-2.5 text-slate-400" strokeWidth={3} />
                            </motion.span>
                          )}
                        </AnimatePresence>
                        <motion.span
                          animate={{
                            color: req.met ? "#0A6E47" : "#8A9BB8",
                          }}
                          transition={{ duration: 0.3 }}
                        >
                          {req.label}
                        </motion.span>
                      </motion.div>
                    ))}
                  </div>
                </motion.div>

                <motion.div variants={itemVariants}>
                  <Button
                    type="submit"
                    className="w-full h-11 bg-gradient-to-r from-primary to-blue-700 hover:from-blue-700 hover:to-primary text-white font-bold rounded-lg shine-sweep transition-all hover:shadow-lg hover:shadow-blue-500/30 active:scale-[0.98] mt-4 disabled:opacity-50 disabled:saturate-50"
                    disabled={loading || !isPasswordStrong}
                  >
                    {loading ? (
                      <div className="flex items-center gap-2">
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        Processing...
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        Create Account
                        <ArrowRight className="h-4 w-4" />
                      </div>
                    )}
                  </Button>
                </motion.div>
              </form>
            </CardContent>
            <CardFooter className="flex flex-col space-y-4">
              <motion.div variants={itemVariants} className="relative w-full">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-[#E0E6EF]" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-white px-2 text-[#8A9BB8] font-semibold">Already have an account?</span>
                </div>
              </motion.div>
              <motion.div variants={itemVariants} className="w-full">
                <Link to="/login" className="w-full block">
                  <Button variant="outline" className="w-full h-11 border-[#E0E6EF] text-[#4A5A72] hover:bg-[#F0F3F8] hover:text-[#0C1829] hover:border-primary/40 font-bold transition-all hover:scale-[1.01]">
                    <LogIn className="mr-2 h-4 w-4" />
                    Sign in instead
                  </Button>
                </Link>
              </motion.div>
            </CardFooter>
          </Card>
        </motion.div>

        <motion.p
          variants={itemVariants}
          className="mt-8 text-center text-xs text-[#8A9BB8] font-medium uppercase tracking-widest"
        >
          &copy; 2026 LandwiseAI — Legal Gating Systems
        </motion.p>
      </motion.div>
    </div>
  );
};

export default SignupPage;
