// frontend/src/constants/jobPositions.ts
/**
 * Default Job Positions Constants
 * 
 * These are hardcoded job position options that all groups can use.
 * Job positions are ID-based to allow label changes while maintaining data integrity.
 * 
 * Future enhancement: Move to database table for custom job positions per group/tenant.
 */

export interface JobPosition {
  id: string;
  label: string;
}

export const DEFAULT_JOB_POSITIONS: JobPosition[] = [
  { id: 'c_level', label: 'C-Level' },
  { id: 'executive', label: 'Executive' },
  { id: 'president', label: 'President' },
  { id: 'vice_president', label: 'Vice President' },
  { id: 'director', label: 'Director' },
  { id: 'manager', label: 'Manager' },
  { id: 'supervisor', label: 'Supervisor' },
  { id: 'team_lead', label: 'Team Lead' },
  { id: 'employee', label: 'Employee' },
  { id: 'hourly', label: 'Hourly' }
];

/**
 * Get job position label by ID
 */
export const getJobPositionLabel = (id: string | null | undefined): string => {
  if (!id) return '';
  const position = DEFAULT_JOB_POSITIONS.find(p => p.id === id);
  return position?.label || id;
};

/**
 * Get job position ID from label (case-insensitive)
 * Useful for importing from CSV/text data
 */
export const getJobPositionId = (label: string | null | undefined): string | null => {
  if (!label) return null;
  const normalizedLabel = label.trim().toLowerCase();
  const position = DEFAULT_JOB_POSITIONS.find(
    p => p.label.toLowerCase() === normalizedLabel || p.id.toLowerCase() === normalizedLabel
  );
  return position?.id || null;
};

/**
 * Get all job position IDs
 */
export const getJobPositionIds = (): string[] => {
  return DEFAULT_JOB_POSITIONS.map(p => p.id);
};

