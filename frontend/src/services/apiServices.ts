// src/services/apiServices.ts
import { apiService } from './api.service';

// Re-export for backward compatibility
export { apiService };
export default apiService;

// Toast notification utility
export class Toast {
  static success(message: string) {
    console.log('Success:', message);
  }

  static error(message: string) {
    console.error('Error:', message);
  }

  static info(message: string) {
    console.info('Info:', message);
  }

  static warning(message: string) {
    console.warn('Warning:', message);
  }
}
