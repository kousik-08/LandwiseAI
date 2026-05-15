import React, { createContext, useContext, useState, useEffect } from "react";
import axios from "axios";
import { toast } from "sonner";

interface User {
  id: string;
  full_name: string;
  email: string;
  role: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (fullName: string, email: string, password: string, roleName?: string) => Promise<void>;
  logout: () => Promise<void>;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Set default axios config for credentials
axios.defaults.withCredentials = true;

const API_BASE_URL = "http://localhost:8000/api/v1";

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const checkSession = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/auth/me`);
      setUser(response.data);
    } catch (error) {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkSession();
  }, []);

  const login = async (email: string, password: string) => {
    try {
      const response = await axios.post(`${API_BASE_URL}/auth/login`, null, {
        params: { email, password },
      });
      setUser(response.data.user);
      toast.success("Welcome back, " + response.data.user.full_name);
    } catch (error: any) {
      const message = error.response?.data?.detail || "Login failed";
      toast.error(message);
      throw error;
    }
  };

  const signup = async (fullName: string, email: string, password: string, roleName: string = "legal_advisor") => {
    try {
      await axios.post(`${API_BASE_URL}/auth/signup`, null, {
        params: { full_name: fullName, email, password, role_name: roleName },
      });
      toast.success("Account created successfully. Please login.");
    } catch (error: any) {
      const message = error.response?.data?.detail || "Signup failed";
      toast.error(message);
      throw error;
    }
  };

  const logout = async () => {
    try {
      await axios.post(`${API_BASE_URL}/auth/logout`);
      setUser(null);
      toast.info("Logged out successfully");
    } catch (error) {
      toast.error("Logout failed");
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, logout, isAuthenticated: !!user }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
