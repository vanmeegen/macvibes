import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import type { ChatPageModel } from '../../models/ChatPageModel';
import type { ChatStore } from '../../models/ChatStore';
import { MessageBubble } from './MessageBubble';
import type { JSX } from 'react';

/**
 * Nachrichtenliste samt „Agent arbeitet"-Bubble und Auto-Scroll. Eigener
 * Observer: Streaming-Deltas und neue Nachrichten rendern nur diese Liste neu,
 * nicht die ganze Seite (Kopfzeile, Eingabe, Preview).
 */
export const ChatMessageList = observer(function ChatMessageList({
  model,
  chatStore,
}: {
  model: ChatPageModel;
  chatStore: ChatStore;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Immer ans Ende scrollen, wenn neue Events eintreffen (reiner View-Effekt).
  const messageCount = chatStore.messages.length;
  const lastContentLength = chatStore.messages[messageCount - 1]?.content.length ?? 0;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messageCount, lastContentLength]);

  return (
    <Box
      ref={scrollRef}
      sx={{ flexGrow: 1, overflowY: 'auto', p: 2, display: 'flex', flexDirection: 'column' }}
    >
      <Stack spacing={1.5}>
        {messageCount === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
            Noch keine Nachrichten — beschreibe dem Agenten, was er bauen soll.
          </Typography>
        )}
        {chatStore.messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {chatStore.showWorkingIndicator && (
          <Box
            sx={{ display: 'flex', justifyContent: 'flex-start' }}
            data-testselector="chat-working"
          >
            <Paper variant="outlined" sx={{ px: 2, py: 1 }}>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                <CircularProgress size={14} />
                <Typography variant="body2" color="text.secondary">
                  {model.workingLabel}
                </Typography>
              </Stack>
            </Paper>
          </Box>
        )}
      </Stack>
    </Box>
  );
});
