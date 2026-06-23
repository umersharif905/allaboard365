import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link as LinkIcon, Pause, Play, Volume2 } from 'lucide-react';

import BlobService from '../../../../services/blob.service';
import type { TrainingAttachment } from '../trainingTypes';

const formatAudioTime = (value: number): string => {
  if (!Number.isFinite(value) || value < 0) {
    return '0:00';
  }

  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

export function isLikelyAudioFileUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const pathname = new URL(trimmed).pathname;
    return /\.(mp3|m4a|wav|ogg|aac|flac)(\?|$)/i.test(pathname);
  } catch {
    return /\.(mp3|m4a|wav|ogg|aac|flac)(\?|$)/i.test(trimmed);
  }
}

type Props = {
  attachment: TrainingAttachment;
  className?: string;
  /** Fires after playback successfully starts from a paused/stopped state (e.g. user pressed play). */
  onPlayStart?: () => void;
  /** Fires when playback stops: user paused, or clip reached the end. */
  onPlayPause?: () => void;
};

const AudioAttachmentPlayer: React.FC<Props> = ({ attachment, className, onPlayStart, onPlayPause }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [resolvedUrl, setResolvedUrl] = useState(attachment.url || '');
  const [isResolvingUrl, setIsResolvingUrl] = useState(false);
  const [audioLoadError, setAudioLoadError] = useState<string | null>(null);
  const [hasRetriedAuthUrl, setHasRetriedAuthUrl] = useState(false);

  const progressPercent = useMemo(() => {
    if (!durationSeconds || durationSeconds <= 0) {
      return 0;
    }

    return Math.min(100, Math.max(0, (currentTimeSeconds / durationSeconds) * 100));
  }, [currentTimeSeconds, durationSeconds]);

  useEffect(() => {
    const audioElement = audioRef.current;
    if (!audioElement) {
      return;
    }

    const onLoadedMetadata = (): void => {
      setDurationSeconds(audioElement.duration || 0);
    };

    const onTimeUpdate = (): void => {
      setCurrentTimeSeconds(audioElement.currentTime || 0);
    };

    const onPlay = (): void => {
      setIsPlaying(true);
    };

    const onPause = (): void => {
      setIsPlaying(false);
    };

    const onEnded = (): void => {
      setIsPlaying(false);
      onPlayPause?.();
    };
    const onError = (): void => {
      setIsPlaying(false);
      const originalUrl = attachment.url?.trim() || '';
      if (!hasRetriedAuthUrl && originalUrl && BlobService.isBlobUrl(originalUrl)) {
        setHasRetriedAuthUrl(true);
        setAudioLoadError('Refreshing secure audio URL...');
        BlobService.clearCache();
        BlobService.getAuthenticatedUrl(originalUrl)
          .then((nextUrl) => {
            setResolvedUrl(nextUrl || originalUrl);
            setAudioLoadError(null);
          })
          .catch(() => {
            setAudioLoadError('Audio failed to load. Verify the file URL or upload again.');
          });
        return;
      }
      setAudioLoadError('Audio failed to load. Verify the file URL or upload again.');
    };

    audioElement.addEventListener('loadedmetadata', onLoadedMetadata);
    audioElement.addEventListener('timeupdate', onTimeUpdate);
    audioElement.addEventListener('play', onPlay);
    audioElement.addEventListener('pause', onPause);
    audioElement.addEventListener('ended', onEnded);
    audioElement.addEventListener('error', onError);

    return () => {
      audioElement.removeEventListener('loadedmetadata', onLoadedMetadata);
      audioElement.removeEventListener('timeupdate', onTimeUpdate);
      audioElement.removeEventListener('play', onPlay);
      audioElement.removeEventListener('pause', onPause);
      audioElement.removeEventListener('ended', onEnded);
      audioElement.removeEventListener('error', onError);
    };
  }, [attachment.url, hasRetriedAuthUrl, onPlayPause]);

  useEffect(() => {
    setHasRetriedAuthUrl(false);
    let isMounted = true;
    const resolvePlayableUrl = async (): Promise<void> => {
      const originalUrl = attachment.url?.trim() || '';
      setResolvedUrl(originalUrl);
      setAudioLoadError(null);

      if (!originalUrl || !BlobService.isBlobUrl(originalUrl)) {
        return;
      }

      setIsResolvingUrl(true);
      try {
        const authenticatedUrl = await BlobService.getAuthenticatedUrl(originalUrl);
        if (isMounted) {
          setResolvedUrl(authenticatedUrl || originalUrl);
        }
      } catch {
        if (isMounted) {
          setResolvedUrl(originalUrl);
        }
      } finally {
        if (isMounted) {
          setIsResolvingUrl(false);
        }
      }
    };

    resolvePlayableUrl();

    return () => {
      isMounted = false;
    };
  }, [attachment.url]);

  useEffect(() => {
    const audioElement = audioRef.current;
    if (!audioElement || !resolvedUrl?.trim()) {
      return;
    }
    setCurrentTimeSeconds(0);
    setDurationSeconds(0);
    setIsPlaying(false);
    setAudioLoadError(null);
    audioElement.load();
  }, [resolvedUrl]);

  useEffect(() => {
    const audioElement = audioRef.current;
    if (!audioElement) {
      return;
    }

    audioElement.playbackRate = playbackRate;
  }, [playbackRate, resolvedUrl]);

  const togglePlayback = async (): Promise<void> => {
    const audioElement = audioRef.current;
    if (!audioElement) {
      return;
    }

    if (audioElement.paused) {
      try {
        await audioElement.play();
        onPlayStart?.();
      } catch {
        setIsPlaying(false);
      }
      return;
    }

    audioElement.pause();
    onPlayPause?.();
  };

  const seekAudio = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const audioElement = audioRef.current;
    if (!audioElement) {
      return;
    }

    const nextValue = Number(event.target.value) || 0;
    audioElement.currentTime = nextValue;
    setCurrentTimeSeconds(nextValue);
  };

  return (
    <div className={`rounded-md border border-violet-200 bg-violet-50 p-3 ${className || ''}`}>
      <h4 className="text-xs font-semibold text-violet-900 uppercase tracking-wide mb-2">
        <span className="inline-flex items-center gap-1.5">
          <Volume2 className="h-3.5 w-3.5 text-violet-800" />
          <span>{attachment.title || 'Audio Clip'}</span>
        </span>
      </h4>

      <audio ref={audioRef} src={resolvedUrl} preload="metadata" />

      <div className="rounded-md border border-violet-200 bg-white p-3">
        {isResolvingUrl && (
          <div className="mb-2 inline-flex items-center gap-2 text-xs text-violet-800">
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-violet-300 border-t-violet-700" />
            <span>Preparing audio...</span>
          </div>
        )}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={togglePlayback}
            className="inline-flex items-center justify-center rounded-full border border-violet-300 bg-violet-100 h-9 w-9 text-violet-900 hover:bg-violet-200"
            aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
          </button>

          <div className="flex-1">
            <div className="relative h-10 overflow-hidden rounded border border-violet-200 bg-violet-50">
              <div
                className="absolute inset-0"
                style={{
                  backgroundImage:
                    'repeating-linear-gradient(to right, rgba(109, 40, 217, 0.35) 0 3px, transparent 3px 8px)'
                }}
              />
              <div
                className="absolute inset-y-0 left-0 bg-violet-300/45 transition-all duration-150"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <input
              type="range"
              min={0}
              max={durationSeconds || 0}
              step={0.1}
              value={Math.min(currentTimeSeconds, durationSeconds || 0)}
              onChange={seekAudio}
              className="w-full mt-2 accent-violet-700"
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex items-center rounded-md border border-violet-200 bg-violet-50 p-1">
            {[1, 1.2, 1.5].map((rate) => {
              const isActive = playbackRate === rate;
              const label = `${rate}x`;

              return (
                <button
                  key={rate}
                  type="button"
                  onClick={() => setPlaybackRate(rate)}
                  className={[
                    'px-2 py-1 text-xs font-semibold rounded',
                    isActive
                      ? 'bg-violet-700 text-white'
                      : 'text-violet-900 hover:bg-violet-100'
                  ].join(' ')}
                  aria-pressed={isActive}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3 text-xs text-violet-900">
            <span>{formatAudioTime(currentTimeSeconds)}</span>
            <span className="text-violet-500">/</span>
            <span>{formatAudioTime(durationSeconds)}</span>
          </div>
        </div>

        {audioLoadError && <p className="mt-2 text-xs text-red-700">{audioLoadError}</p>}
      </div>

      <a
        href={resolvedUrl || attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex items-center gap-1 rounded border border-violet-300 bg-white px-2.5 py-1 text-xs text-violet-900 hover:bg-violet-100"
      >
        <LinkIcon className="h-3.5 w-3.5" />
        <span>Open audio URL</span>
      </a>
    </div>
  );
};

export default AudioAttachmentPlayer;
