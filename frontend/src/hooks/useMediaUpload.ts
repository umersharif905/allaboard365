import { useMutation } from '@tanstack/react-query';
import { marketplaceService } from '../services/MarketplaceService';

interface MediaUploadResponse {
  success: boolean;
  url: string;
  message?: string;
}

const uploadMedia = async (file: File, type: string): Promise<MediaUploadResponse> => {
  try {
    // Map the type to the correct fileType for the upload service
    let fileType: 'images' | 'logos' | 'documents';
    switch (type) {
      case 'bundle-logos':
      case 'product-logos':
        fileType = 'logos';
        break;
      case 'product-images':
        fileType = 'images';
        break;
      default:
        fileType = 'images';
    }

    const result = await marketplaceService.uploadFile(file, fileType);
    
    if (result.success && result.data) {
      return {
        success: true,
        url: result.data.url,
        message: 'File uploaded successfully'
      };
    } else {
      throw new Error(result.error || 'Upload failed');
    }
  } catch (error) {
    console.error('Media upload error:', error);
    throw error;
  }
};

export const useMediaUpload = () => {
  return useMutation({
    mutationFn: ({ file, type }: { file: File; type: string }) => uploadMedia(file, type),
  });
};
