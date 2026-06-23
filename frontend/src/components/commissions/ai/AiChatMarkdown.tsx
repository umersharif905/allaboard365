import { Box, type SxProps, type Theme } from '@mui/material';
import ReactMarkdown from 'react-markdown';

export type AiChatMarkdownVariant = 'body2' | 'subtitle2';

const sharedMarkdownSx = {
  '& p': { m: 0, '& + p': { mt: 1 } },
  '& ul, & ol': { my: 0.5, pl: 2.25, fontSize: 'inherit', lineHeight: 'inherit' },
  '& li': { fontSize: 'inherit', lineHeight: 'inherit' },
  '& li > p': { mt: 0 },
  '& strong': { fontWeight: 700, fontSize: 'inherit' },
  '& em': { fontStyle: 'italic', fontSize: 'inherit' },
  '& h1, & h2, & h3, & h4, & h5, & h6': {
    fontSize: 'inherit',
    lineHeight: 'inherit',
    fontWeight: 600,
    my: 0.5,
    '&:first-of-type': { mt: 0 },
  },
  '& code': {
    fontSize: '0.92em',
    lineHeight: 'inherit',
    px: 0.5,
    py: 0.125,
    borderRadius: 0.5,
    bgcolor: 'action.hover',
    fontFamily: 'monospace',
  },
  '& pre': {
    fontSize: 'inherit',
    lineHeight: 'inherit',
    overflow: 'auto',
    my: 0.5,
    p: 1,
    bgcolor: 'action.hover',
    borderRadius: 1,
  },
  '& pre code': { bgcolor: 'transparent', p: 0, fontSize: 'inherit' },
  '& a': { fontSize: 'inherit', wordBreak: 'break-word' },
  '& blockquote': {
    m: 0,
    pl: 1.5,
    borderLeft: '3px solid',
    borderColor: 'divider',
    fontSize: 'inherit',
    lineHeight: 'inherit',
  },
};

type AiChatMarkdownProps = {
  children: string;
  variant?: AiChatMarkdownVariant;
  sx?: SxProps<Theme>;
};

/**
 * Renders assistant/user markdown at MUI body2 or subtitle2 metrics so **bold**
 * and lists match surrounding typography size.
 */
/** Markdown hard breaks for single newlines in chat prose. */
function withMarkdownLineBreaks(text: string): string {
  if (!text) return '';
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '  \n');
}

export function AiChatMarkdown({ children, variant = 'body2', sx }: AiChatMarkdownProps) {
  const typoKey = variant === 'subtitle2' ? 'subtitle2' : 'body2';
  const mdSource = withMarkdownLineBreaks(children || '');

  return (
    <Box
      component="div"
      sx={{
        typography: typoKey,
        fontSize: (t: Theme) => t.typography[typoKey].fontSize,
        lineHeight: (t: Theme) => t.typography[typoKey].lineHeight,
        ...sharedMarkdownSx,
        ...sx,
      }}
    >
      <ReactMarkdown>{mdSource}</ReactMarkdown>
    </Box>
  );
}
