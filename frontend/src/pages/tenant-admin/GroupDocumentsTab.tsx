// File: frontend/src/pages/tenant-admin/GroupDocumentsTab.tsx
// Updated GroupDocumentsTab.tsx - Production Ready
import React, { useState, useEffect, useRef } from 'react';
import { apiService } from '../../services/apiServices';
import {
  Box,
  Typography,
  Button,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  Alert,
  Snackbar,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  TextField,
  IconButton,
  Stack,
  Tooltip,
  useTheme,
  alpha,
  CircularProgress,
  Card,
  CardContent,
  Grid,
} from '@mui/material';
import {
  CloudUpload as UploadIcon,
  Download as DownloadIcon,
  Delete as DeleteIcon,
  Description as DocumentIcon,
  PictureAsPdf as PdfIcon,
  InsertDriveFile as FileIcon,
  Visibility as ViewIcon,
  CheckCircle as CheckCircleIcon,
  Article as ArticleIcon,
  Assignment as AssignmentIcon,
  AccountBalance as AccountBalanceIcon,
  Work as WorkIcon,
  Folder as FolderIcon,
  CalendarToday as CalendarIcon,
  Person as PersonIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { format } from 'date-fns';

// Types
interface Document {
  DocumentId: string;
  GroupId: string;
  FileName: string;
  FileType: string;
  FileSize: number;
  DocumentType: 'W-9' | 'ParticipationAgreement' | 'PayrollFile' | 'OnboardingDocs' | 'Other';
  Description?: string;
  UploadedDate: string;
  UploadedBy: string;
  UploadedByName: string;
  Url: string;
  Status: 'Active' | 'Archived';
  StoredFileName?: string;
  ContainerName?: string;
}

interface GroupDocumentsTabProps {
  groupId: string;
  groupName: string;
}

// Upload Dialog Component
interface UploadDialogProps {
  open: boolean;
  onClose: () => void;
  onUpload: (files: File[], documentType: string, description: string) => void;
}

const UploadDialog: React.FC<UploadDialogProps> = ({ open, onClose, onUpload }) => {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [documentType, setDocumentType] = useState<string>('Other');
  const [description, setDescription] = useState<string>('');
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const theme = useTheme();

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setSelectedFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFiles(Array.from(e.target.files));
    }
  };

  const handleUpload = () => {
    if (selectedFiles.length > 0) {
      onUpload(selectedFiles, documentType, description);
      handleClose();
    }
  };

  const handleClose = () => {
    setSelectedFiles([]);
    setDocumentType('Other');
    setDescription('');
    onClose();
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          Upload Documents
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ mt: 2 }}>
          {/* Document Type Selection */}
          <FormControl fullWidth>
            <InputLabel>Document Type</InputLabel>
            <Select
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value)}
              label="Document Type"
            >
              <MenuItem value="W-9">W-9 Form</MenuItem>
              <MenuItem value="ParticipationAgreement">Participation Agreement</MenuItem>
              <MenuItem value="PayrollFile">Payroll File</MenuItem>
              <MenuItem value="OnboardingDocs">Onboarding Documents</MenuItem>
              <MenuItem value="Other">Other</MenuItem>
            </Select>
          </FormControl>

          {/* Description */}
          <TextField
            label="Description (Optional)"
            multiline
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            fullWidth
          />

          {/* File Upload Area */}
          <Box
            sx={{
              border: `2px dashed ${dragActive ? '#1f8dbf' : '#e5e7eb'}`,
              borderRadius: 2,
              p: 3,
              textAlign: 'center',
              backgroundColor: dragActive ? '#d6eef8' : 'transparent',
              cursor: 'pointer',
              transition: 'all 0.3s ease',
            }}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              style={{ display: 'none' }}
              accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.jpg,.jpeg,.png"
            />
            
            <UploadIcon sx={{ fontSize: 48, color: '#1f8dbf', mb: 2 }} />
            <Typography variant="body1" sx={{ mb: 1 }}>
              {selectedFiles.length > 0
                ? `${selectedFiles.length} file(s) selected`
                : 'Drag and drop files here or click to browse'}
            </Typography>
            <Typography variant="caption" sx={{ color: '#6b7280' }}>
              Supported formats: PDF, DOC, DOCX, XLS, XLSX, CSV, JPG, PNG
            </Typography>
          </Box>

          {/* Selected Files List */}
          {selectedFiles.length > 0 && (
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Selected Files:
              </Typography>
              {selectedFiles.map((file, index) => (
                <Stack
                  key={index}
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  sx={{
                    p: 1,
                    bgcolor: alpha(theme.palette.primary.main, 0.05),
                    borderRadius: 1,
                    mb: 0.5,
                  }}
                >
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <FileIcon fontSize="small" color="primary" />
                    <Typography variant="body2">{file.name}</Typography>
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    {formatFileSize(file.size)}
                  </Typography>
                </Stack>
              ))}
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 3 }}>
        <Button onClick={handleClose} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        <Button
          onClick={handleUpload}
          variant="contained"
          disabled={selectedFiles.length === 0}
          startIcon={<UploadIcon />}
          sx={{ 
            textTransform: 'none',
            bgcolor: '#1f8dbf',
            '&:hover': {
              bgcolor: '#125e82',
            },
            '&:disabled': {
              bgcolor: '#9ca3af',
            },
          }}
        >
          Upload
        </Button>
      </DialogActions>
    </Dialog>
  );
};

const GroupDocumentsTab: React.FC<GroupDocumentsTabProps> = ({ groupId, groupName }) => {
  const theme = useTheme();
  
  // State
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [snackbar, setSnackbar] = useState({
    open: false,
    message: '',
    severity: 'success' as 'success' | 'error' | 'warning' | 'info',
  });

  // API Functions
  const fetchDocuments = async () => {
    try {
      setLoading(true);
      const data = await apiService.get<{ success: boolean; data?: any }>(`/api/groups/${groupId}/documents`);
      if (data.success) {
        setDocuments(data.data || []);
      } else {
        showSnackbar('Failed to load documents', 'error');
        setDocuments([]);
      }
    } catch (error: any) {
      if (error?.response?.status === 404) {
        showSnackbar('Group not found or access denied', 'error');
        setDocuments([]);
      } else if (error?.response?.status === 403) {
        showSnackbar('You do not have permission to view these documents', 'error');
        setDocuments([]);
      } else {
        console.error('Error fetching documents:', error);
        showSnackbar('Error loading documents', 'error');
        setDocuments([]);
      }
    } finally {
      setLoading(false);
    }
  };

  const uploadDocuments = async (files: File[], documentType: string, description: string) => {
    setUploading(true);
    
    try {
      const token = localStorage.getItem('accessToken') || localStorage.getItem('token');
      const formData = new FormData();
      
      files.forEach((file) => {
        formData.append('files', file);
      });
      formData.append('uploadType', 'documents');
      formData.append('entityId', groupId);
      formData.append('fileType', documentType);
      formData.append('description', description);
      formData.append('category', 'group-documents');

      const data = await apiService.post<{ success: boolean; data?: any[]; url?: string; filename?: string }>('/api/uploads', formData);
      
      if (data.success) {
        // Create a standardized file structure from the response
        const standardizedFiles = files.map((file, index) => ({
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          url: data.data?.[index]?.url || data.url || '#',
          storedFileName: data.data?.[index]?.storedFileName || data.filename || file.name,
          containerName: data.data?.[index]?.containerName || 'documents',
        }));
        
        showSnackbar(`Successfully uploaded ${files.length} document(s)`, 'success');
        
        // Save document metadata
        await saveDocumentMetadata(standardizedFiles, documentType, description);
        fetchDocuments();
      } else {
        throw new Error('Upload failed');
      }
    } catch (error) {
      console.error('Error uploading documents:', error);
      showSnackbar(error instanceof Error ? error.message : 'Failed to upload documents', 'error');
    } finally {
      setUploading(false);
    }
  };

  const saveDocumentMetadata = async (uploadedFiles: any[], documentType: string, description: string) => {
    try {
      const token = localStorage.getItem('accessToken') || localStorage.getItem('token');
      
      // Save document metadata to the database
      for (const file of uploadedFiles) {
        const payload = {
          fileName: file.fileName,
          fileType: file.fileType,
          fileSize: file.fileSize,
          documentType: documentType,
          description: description,
          url: file.url,
          storedFileName: file.storedFileName,
          containerName: file.containerName,
        };

        await apiService.post(`/api/groups/${groupId}/documents`, payload);
      }
    } catch (error) {
      console.error('Error saving document metadata:', error);
    }
  };

  const downloadDocument = async (document: Document) => {
    try {
      const data = await apiService.get<{ success: boolean; data?: { downloadUrl?: string } }>(`/api/groups/${groupId}/documents/${document.DocumentId}/download`);
      if (data.success && data.data?.downloadUrl) {
        // Open the download URL in a new tab
        window.open(data.data.downloadUrl, '_blank');
        showSnackbar('Download started', 'success');
      } else {
        throw new Error('Download URL not available');
      }
    } catch (error) {
      console.error('Error downloading document:', error);
      showSnackbar('Failed to download document', 'error');
    }
  };

  const deleteDocument = async (documentId: string) => {
    try {
      const result = await apiService.delete<{ success: boolean }>(`/api/groups/${groupId}/documents/${documentId}`);
      
      if (result.success) {
        showSnackbar('Document deleted successfully', 'success');
        setDocuments(documents.filter(doc => doc.DocumentId !== documentId));
      } else {
        throw new Error('Failed to delete document');
      }
    } catch (error) {
      console.error('Error deleting document:', error);
      showSnackbar('Failed to delete document', 'error');
    }
  };

  // Utility functions
  const showSnackbar = (message: string, severity: 'success' | 'error' | 'warning' | 'info') => {
    setSnackbar({ open: true, message, severity });
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getDocumentIcon = (fileType: string, documentType: string) => {
    if (fileType.includes('pdf')) return <PdfIcon color="error" />;
    
    switch (documentType) {
      case 'W-9':
        return <AccountBalanceIcon color="primary" />;
      case 'ParticipationAgreement':
        return <AssignmentIcon color="secondary" />;
      case 'PayrollFile':
        return <WorkIcon color="success" />;
      case 'OnboardingDocs':
        return <ArticleIcon color="info" />;
      default:
        return <DocumentIcon color="action" />;
    }
  };

  const getDocumentTypeLabel = (type: string) => {
    switch (type) {
      case 'W-9':
        return 'W-9 Form';
      case 'ParticipationAgreement':
        return 'Participation Agreement';
      case 'PayrollFile':
        return 'Payroll File';
      case 'OnboardingDocs':
        return 'Onboarding Documents';
      default:
        return 'Other';
    }
  };

  const getDocumentTypeColor = (type: string) => {
    switch (type) {
      case 'W-9':
        return 'primary';
      case 'ParticipationAgreement':
        return 'secondary';
      case 'PayrollFile':
        return 'success';
      case 'OnboardingDocs':
        return 'info';
      default:
        return 'default';
    }
  };

  // Group documents by type for summary
  const documentSummary = documents.reduce((acc, doc) => {
    acc[doc.DocumentType] = (acc[doc.DocumentType] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Effects
  useEffect(() => {
    fetchDocuments();
  }, [groupId]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Document Management
          </Typography>
          <Typography variant="body2" sx={{ color: '#6b7280' }}>
            Upload and manage important documents for {groupName}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <IconButton
            onClick={fetchDocuments}
            disabled={loading}
            sx={{ color: '#6b7280' }}
          >
            <RefreshIcon />
          </IconButton>
          <Button
            variant="contained"
            startIcon={uploading ? <CircularProgress size={16} /> : <UploadIcon />}
            onClick={() => setUploadDialogOpen(true)}
            disabled={uploading}
            sx={{ 
              textTransform: 'none',
              bgcolor: '#1f8dbf',
              '&:hover': {
                bgcolor: '#125e82',
              },
              '&:disabled': {
                bgcolor: '#9ca3af',
              },
            }}
          >
            {uploading ? 'Uploading...' : 'Upload Documents'}
          </Button>
        </Stack>
      </Stack>

      {/* Document Type Summary */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        {['W-9', 'ParticipationAgreement', 'PayrollFile', 'OnboardingDocs'].map((type) => {
          const count = documentSummary[type] || 0;
          const hasDocument = count > 0;
          
          return (
            <Grid size={{ xs: 12, sm: 6, md: 3 }} key={type}>
              <Card 
                sx={{ 
                  borderRadius: 2,
                  border: `1px solid ${hasDocument ? '#10b981' : '#e5e7eb'}`,
                  bgcolor: hasDocument ? '#f0fdf4' : 'background.paper',
                }}
              >
                <CardContent sx={{ p: 2 }}>
                  <Stack direction="row" alignItems="center" spacing={2}>
                    <Box
                      sx={{
                        p: 1,
                        borderRadius: 1,
                        bgcolor: hasDocument 
                          ? '#dcfce7'
                          : '#f3f4f6',
                        color: hasDocument 
                          ? '#10b981'
                          : '#9ca3af',
                      }}
                    >
                      {getDocumentIcon('', type)}
                    </Box>
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {getDocumentTypeLabel(type)}
                      </Typography>
                      <Stack direction="row" alignItems="center" spacing={0.5}>
                        {hasDocument ? (
                          <>
                            <CheckCircleIcon sx={{ fontSize: 14, color: '#10b981' }} />
                            <Typography variant="caption" sx={{ color: '#10b981' }}>
                              {count} file{count > 1 ? 's' : ''}
                            </Typography>
                          </>
                        ) : (
                          <Typography variant="caption" sx={{ color: '#6b7280' }}>
                            Not uploaded
                          </Typography>
                        )}
                      </Stack>
                    </Box>
                  </Stack>
                </CardContent>
              </Card>
            </Grid>
          );
        })}
      </Grid>

      {/* Documents Table */}
      <Paper sx={{ borderRadius: 2, overflow: 'hidden' }}>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Document</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Uploaded By</TableCell>
                <TableCell>Upload Date</TableCell>
                <TableCell>Size</TableCell>
                <TableCell align="center">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {documents.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 8 }}>
                    <Stack alignItems="center" spacing={2}>
                      <FolderIcon sx={{ fontSize: 64, color: '#9ca3af' }} />
                      <Typography variant="h6" sx={{ color: '#6b7280' }}>
                        No documents uploaded yet
                      </Typography>
                      <Typography variant="body2" sx={{ color: '#6b7280' }}>
                        Click "Upload Documents" to add your first document
                      </Typography>
                    </Stack>
                  </TableCell>
                </TableRow>
              ) : (
                documents.map((document) => (
                  <TableRow key={document.DocumentId}>
                    <TableCell>
                      <Stack direction="row" alignItems="center" spacing={1.5}>
                        {getDocumentIcon(document.FileType, document.DocumentType)}
                        <Box>
                          <Typography variant="body2" sx={{ fontWeight: 500 }}>
                            {document.FileName}
                          </Typography>
                          {document.Description && (
                            <Typography variant="caption" color="text.secondary">
                              {document.Description}
                            </Typography>
                          )}
                        </Box>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={getDocumentTypeLabel(document.DocumentType)}
                        color={getDocumentTypeColor(document.DocumentType) as any}
                        size="small"
                        sx={{ fontWeight: 500 }}
                      />
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" alignItems="center" spacing={0.5}>
                        <PersonIcon sx={{ fontSize: 16, color: '#6b7280' }} />
                        <Typography variant="body2">
                          {document.UploadedByName}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" alignItems="center" spacing={0.5}>
                        <CalendarIcon sx={{ fontSize: 16, color: '#6b7280' }} />
                        <Typography variant="body2">
                          {format(new Date(document.UploadedDate), 'MMM dd, yyyy')}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {formatFileSize(document.FileSize)}
                      </Typography>
                    </TableCell>
                    <TableCell align="center">
                      <Stack direction="row" spacing={0.5} justifyContent="center">
                        <Tooltip title="View">
                          <IconButton
                            size="small"
                            onClick={() => window.open(document.Url, '_blank')}
                          >
                            <ViewIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Download">
                          <IconButton
                            size="small"
                            onClick={() => downloadDocument(document)}
                          >
                            <DownloadIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Delete">
                          <IconButton
                            size="small"
                            onClick={() => {
                              setSelectedDocument(document);
                              setDeleteConfirmOpen(true);
                            }}
                            sx={{ color: '#dc2626' }}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Upload Dialog */}
      <UploadDialog
        open={uploadDialogOpen}
        onClose={() => setUploadDialogOpen(false)}
        onUpload={uploadDocuments}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Delete Document
          </Typography>
        </DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mt: 2 }}>
            Are you sure you want to delete "{selectedDocument?.FileName}"? This action cannot be undone.
          </Alert>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button onClick={() => setDeleteConfirmOpen(false)} sx={{ textTransform: 'none' }}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (selectedDocument) {
                deleteDocument(selectedDocument.DocumentId);
                setDeleteConfirmOpen(false);
                setSelectedDocument(null);
              }
            }}
            variant="contained"
            color="error"
            sx={{ textTransform: 'none' }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert 
          onClose={() => setSnackbar({ ...snackbar, open: false })} 
          severity={snackbar.severity}
          sx={{ borderRadius: 2 }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default GroupDocumentsTab;