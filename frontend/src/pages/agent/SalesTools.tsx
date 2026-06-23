// frontend/src/pages/agent/SalesTools.tsx
import { useEffect, useState } from 'react';
import ProductCard from '../../components/agent/ProductCard';
import { AgentService } from '../../services/agent/agent.service';
import { Product } from '../../types/agent/agent.types';

const SalesTools = () => {
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchProducts = async () => {
            try {
                setLoading(true);
                const response = await AgentService.getAgentProducts();
                if(response.success && response.data) {
                    setProducts(response.data);
                } else {
                    setError(response.message || 'Failed to fetch products.');
                }
            } catch (err) {
                setError('Failed to fetch products.');
                console.error(err);
            } finally {
                setLoading(false);
            }
        };
        fetchProducts();
    }, []);

    if (loading) return <div>Loading...</div>;
    if (error) return <div className="text-red-500">{error}</div>;

    return (
        <div className="p-6">
            <h1 className="text-2xl font-semibold text-gray-900 mb-2">Sales Tools</h1>
            <p className="text-gray-600 mb-6">Access product information, generate enrollment links, and view brochures.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {products.map(product => (
                    <ProductCard key={product.id} product={product} />
                ))}
            </div>
        </div>
    );
};

export default SalesTools;
