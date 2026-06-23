// frontend/src/types/ai/aiProductCreator.types.ts
// TypeScript types for AI Product Creator

import { ProductFormData } from '../sysadmin/addproductswizard.types';

export interface AIProductCreatorProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (productData: ProductFormData) => void;
  vendorId?: string; // Optional - will fetch vendors if not provided
  productOwnerId?: string;
}

export interface AIGenerationProgress {
  stage: 'idle' | 'uploading' | 'processing' | 'generating' | 'validating' | 'success' | 'error';
  message: string;
  attempt?: number;
  maxAttempts?: number;
  validationErrors?: string[];
}

export interface AIGenerationRequest {
  textInput: string;
  files: File[];
  vendorId: string;
  productOwnerId: string;
}

export interface AIGenerationResponse {
  success: boolean;
  data?: ProductFormData;
  attempts?: number;
  message?: string;
  validationErrors?: string[];
  error?: string;
}

export interface FileWithPreview {
  file: File;
  preview: string;
  name: string;
  size: number;
  type: string;
}

