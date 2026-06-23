// src/components/common/OptimizedImage.tsx
// Reusable image component with fallbacks and loading states

import React, { useState } from 'react';
import { IMAGES, getProductImage } from '../../constants/images';

interface OptimizedImageProps {
  src: string | null;
  alt: string;
  fallbackSrc?: string;
  className?: string;
  width?: number;
  height?: number;
  loading?: 'lazy' | 'eager';
}

export const OptimizedImage: React.FC<OptimizedImageProps> = ({
  src,
  alt,
  fallbackSrc = IMAGES.UI.PRODUCT_PLACEHOLDER,
  className = '',
  width,
  height,
  loading = 'lazy'
}) => {
  const [imageError, setImageError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const handleError = () => {
    setImageError(true);
    setIsLoading(false);
  };

  const handleLoad = () => {
    setIsLoading(false);
  };

  const imageSrc = imageError || !src ? fallbackSrc : src;

  return (
    <div className={`relative ${className}`}>
      {isLoading && (
        <div className="absolute inset-0 bg-gray-200 animate-pulse rounded" />
      )}
      <img
        src={imageSrc}
        alt={alt}
        width={width}
        height={height}
        loading={loading}
        onError={handleError}
        onLoad={handleLoad}
        className={`${isLoading ? 'opacity-0' : 'opacity-100'} transition-opacity duration-200`}
      />
    </div>
  );
};

// Specialized components for common use cases
export const TenantLogo: React.FC<{
  logoUrl: string | null;
  tenantName: string;
  size?: 'sm' | 'md' | 'lg';
}> = ({ logoUrl, tenantName, size = 'md' }) => {
  const sizeClasses = {
    sm: 'w-8 h-8',
    md: 'w-12 h-12', 
    lg: 'w-16 h-16'
  };

  return (
    <OptimizedImage
      src={logoUrl}
      alt={`${tenantName} logo`}
      fallbackSrc={IMAGES.UI.COMPANY_PLACEHOLDER}
      className={`${sizeClasses[size]} rounded-full object-cover`}
    />
  );
};

export const ProductImage: React.FC<{
  imageUrl: string | null;
  productName: string;
  productType: string;
  className?: string;
}> = ({ imageUrl, productName, productType, className = 'w-full h-48 object-cover' }) => {
  return (
    <OptimizedImage
      src={imageUrl}
      alt={`${productName} product image`}
      fallbackSrc={getProductImage(null, productType)}
      className={className}
    />
  );
};
