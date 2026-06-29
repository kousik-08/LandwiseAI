import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { LockKeyhole, Mail, UserPlus, ArrowRight } from "lucide-react";
import { motion } from "framer-motion";

const LoginPage = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(email, password);
      navigate("/", { replace: true });
    } catch (error) {
      // Error is handled in AuthContext with toast
    } finally {
      setLoading(false);
    }
  };

  const containerVariants = {
    hidden: {},
    visible: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
  };
  const itemVariants = {
    hidden: { opacity: 0, y: 14 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } },
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#F0F3F8] via-[#EEF2FF] to-[#F0F3F8] p-4 font-sans text-[#0C1829] relative overflow-hidden">
      {/* Animated background blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-[15%] -left-[10%] w-[45%] h-[45%] bg-primary/15 rounded-full blur-[120px] animate-blob" />
        <div className="absolute -bottom-[15%] -right-[10%] w-[45%] h-[45%] bg-indigo-400/15 rounded-full blur-[120px] animate-blob-slow" />
        <div className="absolute top-[30%] right-[20%] w-[25%] h-[25%] bg-purple-400/10 rounded-full blur-[100px] animate-float-slow" />
        {/* Subtle grid */}
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
        className="w-full max-w-sm z-10"
      >
        <motion.div variants={itemVariants} className="flex flex-col items-center mb-4">
          <motion.div
            initial={{ scale: 0.5, rotate: -12, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ duration: 0.7, ease: [0.34, 1.56, 0.64, 1] }}
            className="w-11 h-11 bg-gradient-to-br from-primary to-blue-700 rounded-xl flex items-center justify-center shadow-lg mb-2.5 shadow-blue-500/30 relative"
          >
            <div className="absolute inset-0 rounded-xl bg-primary/40 blur-lg -z-10 animate-pulse-glow" />
            <LockKeyhole className="text-white w-5 h-5" />
          </motion.div>
          <h1 className="text-xl font-extrabold tracking-tight text-[#0C1829]">
            Land<span className="text-gradient-primary">wiseAI</span>
          </h1>
          <p className="text-[#8A9BB8] text-[11px] mt-1">Sign in to your legal command center</p>
        </motion.div>

        <motion.div variants={itemVariants}>
          <Card className="border-[#E0E6EF] shadow-xl bg-white/80 backdrop-blur-xl hover:shadow-blue-500/10 transition-shadow duration-500">
            <CardHeader className="space-y-0.5 p-4 pb-2">
              <CardTitle className="text-base font-bold">Welcome back</CardTitle>
              <CardDescription className="text-xs text-[#4A5A72]">
                Enter your credentials to access your dashboard
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              <form onSubmit={handleSubmit} className="space-y-3">
                <motion.div variants={itemVariants} className="space-y-1">
                  <Label htmlFor="email" className="text-[11px] font-semibold text-[#4A5A72]">Email address</Label>
                  <div className="relative group focus-glow rounded-md transition-all">
                    <Mail className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-[#8A9BB8] group-focus-within:text-primary transition-colors" />
                    <Input
                      id="email"
                      type="email"
                      placeholder="name@company.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="pl-8 text-xs bg-[#F0F3F8] border-[#E0E6EF] focus:ring-primary focus:border-primary h-9 transition-all"
                    />
                  </div>
                </motion.div>
                <motion.div variants={itemVariants} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password" className="text-[11px] font-semibold text-[#4A5A72]">Password</Label>
                    <a href="#" className="text-[10px] text-primary hover:underline font-semibold transition-colors hover:text-blue-700">
                      Forgot password?
                    </a>
                  </div>
                  <div className="relative group focus-glow rounded-md transition-all">
                    <LockKeyhole className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-[#8A9BB8] group-focus-within:text-primary transition-colors" />
                    <Input
                      id="password"
                      type="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      className="pl-8 text-xs bg-[#F0F3F8] border-[#E0E6EF] focus:ring-primary focus:border-primary h-9 transition-all"
                    />
                  </div>
                </motion.div>
                <motion.div variants={itemVariants}>
                  <Button
                    type="submit"
                    className="w-full h-9 text-xs bg-gradient-to-r from-primary to-blue-700 hover:from-blue-700 hover:to-primary text-white font-bold rounded-md shine-sweep transition-all hover:shadow-lg hover:shadow-blue-500/30 active:scale-[0.98]"
                    disabled={loading}
                  >
                    {loading ? (
                      <div className="flex items-center gap-1.5">
                        <div className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        Authenticating...
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        Sign In
                        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
                      </div>
                    )}
                  </Button>
                </motion.div>
              </form>
            </CardContent>
            <CardFooter className="flex flex-col space-y-2.5 p-4 pt-0">
              <motion.div variants={itemVariants} className="relative w-full">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-[#E0E6EF]" />
                </div>
                <div className="relative flex justify-center text-[10px] uppercase">
                  <span className="bg-white px-2 text-[#8A9BB8] font-semibold tracking-wider">New to LandwiseAI?</span>
                </div>
              </motion.div>
              <motion.div variants={itemVariants} className="w-full">
                <Link to="/signup" className="w-full block">
                  <Button variant="outline" className="w-full h-9 text-xs border-[#E0E6EF] text-[#4A5A72] hover:bg-[#F0F3F8] hover:text-[#0C1829] hover:border-primary/40 font-bold transition-all">
                    <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                    Create a new account
                  </Button>
                </Link>
              </motion.div>
            </CardFooter>
          </Card>
        </motion.div>

        <motion.p
          variants={itemVariants}
          className="mt-4 text-center text-[10px] text-[#8A9BB8] font-medium uppercase tracking-widest"
        >
          &copy; 2026 LandwiseAI — Intelligence for Real Estate
        </motion.p>
      </motion.div>
    </div>
  );
};

export default LoginPage;
