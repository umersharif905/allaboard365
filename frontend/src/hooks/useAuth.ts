// src/hooks/useAuth.ts
import { jwtDecode } from 'jwt-decode';
import { useEffect, useState } from 'react';
import { API_CONFIG } from '../config/api';
import type { LoginCredentials, User } from '../types/index';

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface AuthActions {
  login: (credentials: LoginCredentials) => Promise<boolean>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export function useAuth(): AuthState & AuthActions {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      try {
        const decodedUser: User = jwtDecode(token);
        
        // Fetch complete user profile including roles from UserRoles table
        fetch(`${API_CONFIG.BASE_URL}/api/users/me`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        })
          .then(res => res.json())
          .then(data => {
            if (data.success && data.data) {
              // Use roles from backend (which queries UserRoles table)
              setUser({
                ...decodedUser,
                ...data.data,
                roles: data.data.roles || [],
                currentRole: data.data.currentRole || (data.data.roles && data.data.roles[0])
              });
            } else {
              setUser(decodedUser);
            }
            setIsLoading(false);
          })
          .catch(err => {
            console.error('Error fetching user profile:', err);
            setUser(decodedUser);
            setIsLoading(false);
          });
      } catch (e) {
        console.error('Invalid token:', e);
        localStorage.removeItem('accessToken');
        setIsLoading(false);
      }
    } else {
      setIsLoading(false);
    }
  }, []);

  const login = async (credentials: LoginCredentials): Promise<boolean> => {
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(credentials),
      });

      const data = await response.json();
      
      if (response.ok && data.success) {
        // User data now includes roles array from UserRoles table
        const userData = {
          ...data.data.user,
          roles: data.data.user.roles || [],
          currentRole: data.data.user.currentRole || (data.data.user.roles && data.data.user.roles[0])
        };
        
        setUser(userData);
        localStorage.setItem('accessToken', data.data.accessToken);
        
        // Store roles in localStorage for backward compatibility
        if (userData.roles) {
          localStorage.setItem('roles', JSON.stringify(userData.roles));
        }
        
        setIsLoading(false);
        return true;
      }
      
      setError(data.error?.message || 'Login failed');
      setIsLoading(false);
      return false;
    } catch (err: any) {
      setError(err.message || 'Login failed');
      setIsLoading(false);
      return false;
    }
  };

  const logout = async (): Promise<void> => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
        },
      });
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setUser(null);
      localStorage.removeItem('accessToken');
      localStorage.removeItem('roles');
      localStorage.removeItem('userType'); // Remove deprecated field
    }
  };

  const clearError = () => setError(null);

  return {
    user,
    isAuthenticated: !!user,
    isLoading,
    error,
    login,
    logout,
    clearError,
  };
}

export default useAuth;