import {
    AlertCircle,
    Calendar,
    Download,
    FileText,
    Loader2,
    RefreshCw,
    Search,
    X
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiService } from '../../services/api.service';

// Document interface
interface MemberDocument {
  id: string;
  type: 'signed_agreement' | 'file_upload';
  name: string;
  url: string;
  size: number | null;
  mimeType: string;
  category: string;
  description: string;
  createdDate: string;
  status: string;
  isSignedAgreement: boolean;
  timestamp?: string;
}

interface DocumentsResponse {
  success: boolean;
  data: {
    member: {
      memberId: string;
      firstName: string;
      lastName: string;
      email: string;
    };
    documents: MemberDocument[];
    summary: {
      totalDocuments: number;
      signedAgreements: number;
      fileUploads: number;
    };
  };
}

export default function Documents() {
  const navigate = useNavigate();
  const [documents, setDocuments] = useState<MemberDocument[]>([]);
  const [member, setMember] = useState<any>(null);
  const [summary, setSummary] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  // Fetch documents
  const fetchDocuments = async () => {
    try {
      setIsLoading(true);
      setIsError(false);
      setError(null);

      const response = await apiService.get<DocumentsResponse>('/api/me/member/documents');
      
      if (response.success) {
        setDocuments(response.data.documents);
        setMember(response.data.member);
        setSummary(response.data.summary);
      } else {
        setIsError(true);
        setError('Failed to fetch documents');
      }
    } catch (err) {
      console.error('Error fetching documents:', err);
      setIsError(true);
      setError(err instanceof Error ? err.message : 'Failed to fetch documents');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, []);

  // Filter documents based on search and category
  const filteredDocuments = documents.filter(doc => {
    const matchesSearch = doc.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         doc.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         doc.category.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesCategory = selectedCategory === 'all' || doc.category === selectedCategory;
    
    return matchesSearch && matchesCategory;
  });

  // Get unique categories for filter
  const categories = ['all', ...Array.from(new Set(documents.map(doc => doc.category)))];

  // Format file size
  const formatFileSize = (bytes: number | null): string => {
    if (!bytes) return 'Unknown size';
    
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  };

  // Format date
  const formatDate = (dateString: string): string => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Handle document download
  const handleDownload = (doc: MemberDocument) => {
    if (!doc.url) {
      alert('This document is not currently available for download. Please contact support if you believe this is in error.');
      return;
    }

    const link = document.createElement('a');
    link.href = doc.url;

    if (doc.mimeType && doc.mimeType.includes('pdf')) {
      link.download = `${doc.name || 'document'}.pdf`;
    } else if (doc.mimeType && doc.mimeType.includes('png')) {
      link.download = `${doc.name || 'document'}.png`;
    } else {
      link.download = doc.name || 'document';
    }

    link.rel = 'noopener noreferrer';
    link.target = '_blank';

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Get document type icon and color
  const getDocumentTypeInfo = (doc: MemberDocument) => {
    if (doc.isSignedAgreement) {
      return {
        icon: FileText,
        color: 'text-oe-primary',
        bgColor: 'bg-blue-50',
        label: 'Signed Agreement'
      };
    } else {
      return {
        icon: FileText,
        color: 'text-gray-600',
        bgColor: 'bg-gray-50',
        label: 'Document'
      };
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-center h-64">
            <div className="flex items-center space-x-2">
              <Loader2 className="h-6 w-6 animate-spin text-oe-primary" />
              <span className="text-gray-600">Loading documents...</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-7xl mx-auto">
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="flex items-center space-x-3 text-red-600 mb-4">
              <AlertCircle className="h-6 w-6" />
              <h2 className="text-lg font-semibold">Error Loading Documents</h2>
            </div>
            <p className="text-gray-600 mb-4">{error}</p>
            <button
              onClick={fetchDocuments}
              className="inline-flex items-center px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-0 md:p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6 md:mb-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="text-xl md:text-2xl font-semibold text-gray-900 mb-1 md:mb-2">Documents</h1>
              <p className="text-sm md:text-base text-gray-600">
                View and download your documents and signed agreements
              </p>
            </div>
            <button
              onClick={fetchDocuments}
              className="inline-flex items-center justify-center px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors focus:outline-none focus:ring-2 focus:ring-oe-primary focus:ring-offset-2 min-h-11 self-start sm:self-auto"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </button>
          </div>
        </div>

        {/* Summary Cards */}
        {summary && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 md:gap-6 mb-6 md:mb-8">
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <div className="flex items-center">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <FileText className="h-6 w-6 text-oe-primary" />
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-600">Total Documents</p>
                  <p className="text-2xl font-semibold text-gray-900">{summary.totalDocuments}</p>
                </div>
              </div>
            </div>
            
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <div className="flex items-center">
                <div className="p-2 bg-green-100 rounded-lg">
                  <FileText className="h-6 w-6 text-green-600" />
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-600">Signed Agreements</p>
                  <p className="text-2xl font-semibold text-gray-900">{summary.signedAgreements}</p>
                </div>
              </div>
            </div>
            
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <div className="flex items-center">
                <div className="p-2 bg-gray-100 rounded-lg">
                  <FileText className="h-6 w-6 text-gray-600" />
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-600">File Uploads</p>
                  <p className="text-2xl font-semibold text-gray-900">{summary.fileUploads}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
          <div className="flex flex-col sm:flex-row gap-4">
            {/* Search */}
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search documents..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
                {searchTerm && (
                  <button
                    onClick={() => setSearchTerm('')}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            
            {/* Category Filter */}
            <div className="sm:w-48">
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              >
                {categories.map(category => (
                  <option key={category} value={category}>
                    {category === 'all' ? 'All Categories' : category}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Documents List */}
        <div className="bg-white rounded-lg border border-gray-200">
          {filteredDocuments.length === 0 ? (
            <div className="p-12 text-center">
              <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No documents found</h3>
              <p className="text-gray-600">
                {searchTerm || selectedCategory !== 'all' 
                  ? 'Try adjusting your search or filter criteria.'
                  : 'You don\'t have any documents yet.'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-gray-200">
              {filteredDocuments.map((doc) => {
                const typeInfo = getDocumentTypeInfo(doc);
                const Icon = typeInfo.icon;
                const downloadDisabled = !doc.url;
                
                return (
                  <div key={doc.id} className="p-6 hover:bg-gray-50 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-4">
                        <div className={`p-3 ${typeInfo.bgColor} rounded-lg`}>
                          <Icon className={`h-6 w-6 ${typeInfo.color}`} />
                        </div>
                        
                        <div className="flex-1">
                          <div className="flex items-center space-x-2 mb-1">
                            <h3 className="text-lg font-medium text-gray-900">{doc.name}</h3>
                            <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${typeInfo.bgColor} ${typeInfo.color}`}>
                              {typeInfo.label}
                            </span>
                          </div>
                          
                          <p className="text-sm text-gray-600 mb-2">{doc.description}</p>
                          
                          <div className="flex items-center space-x-4 text-sm text-gray-500">
                            <div className="flex items-center space-x-1">
                              <Calendar className="h-4 w-4" />
                              <span>{formatDate(doc.createdDate)}</span>
                            </div>
                            
                            {doc.size && (
                              <div className="flex items-center space-x-1">
                                <FileText className="h-4 w-4" />
                                <span>{formatFileSize(doc.size)}</span>
                              </div>
                            )}
                            
                            <span className="text-gray-400">•</span>
                            <span>{doc.category}</span>
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => handleDownload(doc)}
                          disabled={downloadDisabled}
                          className={`inline-flex items-center px-3 py-2 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                            downloadDisabled
                              ? 'bg-gray-200 text-gray-500 cursor-not-allowed focus:ring-gray-200'
                              : 'bg-oe-primary text-white hover:bg-oe-dark focus:ring-oe-primary'
                          }`}
                        >
                          <Download className="h-4 w-4 mr-2" />
                          Download
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
