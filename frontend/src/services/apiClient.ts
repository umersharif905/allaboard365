/**
 * Thin axios-compatible shim over apiService.
 * Callers receive `{ data: T }` so they can write `res.data.xxx`,
 * mirroring the raw axios response shape while still going through
 * the shared ApiService instance (auth interceptors, base-URL handling, etc.).
 */
import { apiService } from './api.service';
import type { AxiosRequestConfig } from 'axios';

const apiClient = {
  get: async <T = unknown>(url: string, config?: AxiosRequestConfig): Promise<{ data: T }> => {
    const data = await apiService.get<T>(url, config);
    return { data };
  },
  post: async <T = unknown>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<{ data: T }> => {
    const data = await apiService.post<T>(url, body, config);
    return { data };
  },
  put: async <T = unknown>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<{ data: T }> => {
    const data = await apiService.put<T>(url, body, config);
    return { data };
  },
  delete: async <T = unknown>(url: string, config?: AxiosRequestConfig): Promise<{ data: T }> => {
    const data = await apiService.delete<T>(url, config);
    return { data };
  },
} as const;

export default apiClient;
