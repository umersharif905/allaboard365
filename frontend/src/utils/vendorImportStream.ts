import { apiService } from '../services/api.service';
import { VENDOR_IMPORT_TIMEOUT_MS } from '../constants/uploads';
import { formatImportErrorMessage } from '../components/vendor/import/importDisplay';

export type VendorImportProgressEvent = {
  type?: 'progress' | 'complete' | 'error';
  phase?: string;
  message: string;
  current?: number;
  total?: number;
};

export type VendorImportStreamResult<T> = {
  data: T;
  bundleDir?: string;
};

type ImportJobStatus = {
  jobId: string;
  status: 'running' | 'done' | 'error';
  phase?: string;
  message?: string;
  current?: number | null;
  total?: number | null;
  result?: { data: unknown; bundleDir?: string };
  error?: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const IMPORT_TIMEOUT_MINUTES = Math.round(VENDOR_IMPORT_TIMEOUT_MS / 60000);

function jobPollPath(importPath: string): string {
  if (importPath.includes('/share-requests/')) {
    return '/api/me/vendor/import/share-requests/jobs';
  }
  return '/api/me/vendor/import/jobs';
}

function formatImportError(err: unknown, lastProgress: VendorImportProgressEvent | null): Error {
  const raw = formatImportErrorMessage(
    err instanceof Error ? err.message : err,
    'Import failed',
  );

  if (err instanceof DOMException && err.name === 'AbortError') {
    return new Error(`Import timed out after ${IMPORT_TIMEOUT_MINUTES} minutes.`);
  }

  if (
    raw === 'Load failed'
    || raw === 'Failed to fetch'
    || raw.includes('NetworkError')
    || raw.includes('network error')
  ) {
    const detail = lastProgress?.message
      ? `Last step: “${lastProgress.message}”.`
      : '';
    return new Error(
      `Connection to the server was lost. ${detail} Large imports can hit proxy timeouts — retry, or check backend logs for [vendor-import-job].`.trim()
    );
  }

  return err instanceof Error ? err : new Error(raw);
}

/** Start async import job and poll for progress (reliable on Azure vs long SSE streams). */
export async function runVendorImportJob<T>(
  path: string,
  body: FormData | Record<string, unknown>,
  onProgress: (event: VendorImportProgressEvent) => void
): Promise<VendorImportStreamResult<T>> {
  let lastProgress: VendorImportProgressEvent | null = null;
  const pollBase = jobPollPath(path);

  try {
    onProgress({ message: 'Uploading and starting job…' });

    const startRes = await apiService.post<{ success: boolean; jobId: string; message?: string }>(
      `${path}?async=1`,
      body,
      { timeout: Math.min(VENDOR_IMPORT_TIMEOUT_MS, 120000) }
    );

    if (!startRes.success || !startRes.jobId) {
      throw new Error(formatImportErrorMessage(startRes.message, 'Failed to start import job'));
    }

    const jobId = startRes.jobId;
    const startedAt = Date.now();

    while (Date.now() - startedAt < VENDOR_IMPORT_TIMEOUT_MS) {
      await sleep(1000);

      const poll = await apiService.get<{ success: boolean; job: ImportJobStatus; message?: string }>(
        `${pollBase}/${jobId}`,
        { timeout: 30000 }
      );

      const job = poll.job;
      if (!job) {
        throw new Error(poll.message || 'Import job not found (server may have restarted)');
      }

      if (job.status === 'running') {
        const event: VendorImportProgressEvent = {
          phase: job.phase,
          message: job.message || 'Working…',
          current: job.current ?? undefined,
          total: job.total ?? undefined,
        };
        lastProgress = event;
        onProgress(event);
        continue;
      }

      if (job.status === 'error') {
        throw new Error(formatImportErrorMessage(job.error || job.message, 'Import failed on the server'));
      }

      if (job.status === 'done' && job.result) {
        onProgress({ message: 'Complete' });
        return {
          data: job.result.data as T,
          bundleDir: job.result.bundleDir,
        };
      }
    }

    throw new Error(`Import timed out after ${IMPORT_TIMEOUT_MINUTES} minutes.`);
  } catch (err) {
    throw formatImportError(err, lastProgress);
  }
}

/** @deprecated Use runVendorImportJob — SSE streams drop on Safari/Azure with "Load failed". */
export async function postVendorImportStream<T>(
  path: string,
  body: FormData | Record<string, unknown>,
  onProgress: (event: VendorImportProgressEvent) => void
): Promise<VendorImportStreamResult<T>> {
  return runVendorImportJob<T>(path, body, onProgress);
}
