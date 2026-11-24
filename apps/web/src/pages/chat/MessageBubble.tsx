import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { observer } from 'mobx-react-lite';
import type { ChatMessage } from '../../api/types';

/** Eine Chat-Nachricht — Darstellung je Rolle (User, Agent, Tool, Thinking, System, Fehler). */
export const MessageBubble = observer(function MessageBubble({
  message,
}: {
  message: ChatMessage;
}): JSX.Element {
  if (message.role === 'error') {
    // Fehler nie verschlucken: kurze Überschrift, per Aufklappen der genaue Text.
    return (
      <Alert severity="error" data-testselector="chat-message" data-role="error">
        <Box
          component="details"
          data-testselector="chat-error-details"
          sx={{ '& summary': { cursor: 'pointer', fontWeight: 600, userSelect: 'none' } }}
        >
          <summary>Interner Fehler – Details anzeigen</summary>
          <Box
            component="pre"
            sx={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              m: 0,
              mt: 1,
              fontFamily: 'monospace',
              fontSize: '0.8em',
            }}
          >
            {message.content}
          </Box>
        </Box>
      </Alert>
    );
  }

  if (message.role === 'system') {
    return (
      <Alert severity="info" data-testselector="chat-message" data-role="system">
        {message.content}
      </Alert>
    );
  }

  if (message.role === 'tool') {
    return (
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ fontFamily: 'monospace', px: 1 }}
        data-testselector="chat-message"
        data-role="tool"
      >
        ⚙ {message.content}
      </Typography>
    );
  }

  if (message.role === 'thinking') {
    return (
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ fontStyle: 'italic', px: 1, whiteSpace: 'pre-wrap', opacity: 0.8 }}
        data-testselector="chat-message"
        data-role="thinking"
      >
        💭 {message.content}
      </Typography>
    );
  }

  const isUser = message.role === 'user';
  return (
    <Box
      sx={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}
      data-testselector="chat-message"
      data-role={message.role}
    >
      <Paper
        variant={isUser ? 'elevation' : 'outlined'}
        sx={{
          px: 2,
          py: 1,
          maxWidth: '85%',
          whiteSpace: 'pre-wrap',
          bgcolor: isUser ? 'primary.dark' : 'background.paper',
        }}
      >
        <Typography variant="body2">{message.content}</Typography>
      </Paper>
    </Box>
  );
});
