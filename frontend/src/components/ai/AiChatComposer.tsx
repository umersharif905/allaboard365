import AttachFileIcon from '@mui/icons-material/AttachFile';
import SendIcon from '@mui/icons-material/Send';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  TextField,
  Tooltip,
  type SxProps,
  type Theme,
} from '@mui/material';
import { useRef } from 'react';

export type AiChatComposerProps = {
  prompt: string;
  onPromptChange: (value: string) => void;
  onSend: () => void;
  loading?: boolean;
  disabled?: boolean;
  sendDisabled?: boolean;
  placeholder?: string;
  minRows?: number;
  maxRows?: number;
  showAttach?: boolean;
  onAttachClick?: () => void;
  attachDisabled?: boolean;
  attachTooltip?: string;
  inputRef?: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  sx?: SxProps<Theme>;
};

/** Shared AI chat input: Enter inserts newline; only Send submits. */
export function AiChatComposer({
  prompt,
  onPromptChange,
  onSend,
  loading = false,
  disabled = false,
  sendDisabled = false,
  placeholder = 'Type a message…',
  minRows = 2,
  maxRows = 6,
  showAttach = false,
  onAttachClick,
  attachDisabled = false,
  attachTooltip = 'Attach files',
  inputRef,
  sx,
}: AiChatComposerProps) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const fieldRef = inputRef ?? localRef;

  return (
    <Box display="flex" gap={1} alignItems="flex-end" sx={sx}>
      {showAttach && (
        <Tooltip title={attachTooltip}>
          <span>
            <IconButton
              size="small"
              onClick={onAttachClick}
              disabled={disabled || loading || attachDisabled}
              aria-label="Attach files"
            >
              <AttachFileIcon />
            </IconButton>
          </span>
        </Tooltip>
      )}
      <TextField
        inputRef={fieldRef}
        fullWidth
        multiline
        minRows={minRows}
        maxRows={maxRows}
        placeholder={placeholder}
        value={prompt}
        disabled={disabled || loading}
        onChange={(e) => onPromptChange(e.target.value)}
      />
      <Button
        variant="contained"
        endIcon={loading ? <CircularProgress size={18} color="inherit" /> : <SendIcon />}
        disabled={sendDisabled || loading || disabled}
        onClick={onSend}
      >
        Send
      </Button>
    </Box>
  );
}
