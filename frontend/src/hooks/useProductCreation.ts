import { useMutation } from '@tanstack/react-query';

interface ProductCreationResponse {
  success: boolean;
  productId: string;
  message?: string;
}

const createProduct = async (productData: any): Promise<ProductCreationResponse> => {
  // Mock implementation - replace with actual API call
  return {
    success: true,
    productId: Math.random().toString(36).substr(2, 9),
  };
};

export const useProductCreation = () => {
  return useMutation({
    mutationFn: createProduct,
  });
};
