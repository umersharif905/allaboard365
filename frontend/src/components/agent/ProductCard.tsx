// frontend/src/components/agent/ProductCard.tsx
import { FileText, Link as LinkIcon } from 'lucide-react';
import React from 'react';
import { Product } from '../../types/agent/agent.types';

interface ProductCardProps {
    product: Product;
}

const ProductCard: React.FC<ProductCardProps> = ({ product }) => {
    const { name, carrier, type, description, brochureUrl } = product;
    
    return (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-shadow duration-200 flex flex-col">
            <div className="p-6">
                <div className="flex items-start justify-between">
                    <h2 className="text-lg font-semibold text-gray-900">{name}</h2>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        {type}
                    </span>
                </div>
                <p className="text-sm text-gray-500 mt-1">{carrier}</p>
                <p className="text-sm text-gray-600 mt-4 h-20">{description}</p>
            </div>
            <div className="mt-auto p-6 bg-gray-50 border-t border-gray-200 grid grid-cols-2 gap-2">
                <a href={brochureUrl} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100">
                    <FileText className="h-5 w-5 mr-2" />
                    Brochure
                </a>
                <button className="flex items-center justify-center px-4 py-2 border border-transparent rounded-lg text-sm font-medium text-white bg-oe-primary hover:bg-oe-primary-dark">
                    <LinkIcon className="h-5 w-5 mr-2" />
                    Get Link
                </button>
            </div>
        </div>
    );
};

export default ProductCard;
