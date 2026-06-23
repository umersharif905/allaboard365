// frontend/src/components/common/ErrorNotification.tsx
import { AlertCircle, X } from 'lucide-react';
import React, { useState } from 'react';

interface ErrorNotificationProps {
    error: any;
    title?: string;
}

const ErrorNotification: React.FC<ErrorNotificationProps> = ({ error, title = "API Error" }) => {
    const [isVisible, setIsVisible] = useState(true);

    if (!isVisible || process.env.NODE_ENV !== 'development') {
        return null;
    }

    const errorMessage = error?.response?.data?.message || error?.message || 'An unexpected error occurred.';
    const errorStatus = error?.response?.status;
    const errorEndpoint = error?.config?.url;

    return (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
            <div className="flex items-start">
                <div className="flex-shrink-0">
                    <AlertCircle className="h-5 w-5 text-red-400" />
                </div>
                <div className="ml-3 flex-1">
                    <h3 className="text-sm font-medium text-red-800">{title}</h3>
                    <div className="mt-2 text-sm text-red-700">
                        <p><strong>Status:</strong> {errorStatus || 'N/A'}</p>
                        <p><strong>Endpoint:</strong> {errorEndpoint || 'N/A'}</p>
                        <p><strong>Message:</strong> {errorMessage}</p>
                    </div>
                </div>
                <div className="ml-auto pl-3">
                    <div className="-mx-1.5 -my-1.5">
                        <button
                            type="button"
                            onClick={() => setIsVisible(false)}
                            className="inline-flex bg-red-50 rounded-md p-1.5 text-red-500 hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-red-50 focus:ring-red-600"
                        >
                            <span className="sr-only">Dismiss</span>
                            <X className="h-5 w-5" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ErrorNotification; 