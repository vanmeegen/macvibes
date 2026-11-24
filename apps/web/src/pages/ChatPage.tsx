import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import type { ChatPageModel } from '../models/ChatPageModel';
import type { ChatStore } from '../models/ChatStore';
import type { ProjectsStore } from '../models/ProjectsStore';
import type { SpeechStore } from '../models/SpeechStore';
import { ChatComposer } from './chat/ChatComposer';
import { ChatMessageList } from './chat/ChatMessageList';
import { ChatToolbar } from './chat/ChatToolbar';
import { PreviewPane } from './chat/PreviewPane';

interface ChatPageProps {
  model: ChatPageModel;
  projectsStore: ProjectsStore;
  chatStore: ChatStore;
  speechStore: SpeechStore;
}

/**
 * Projektansicht: Chat mit dem Agenten (links) und Preview (rechts).
 * Nur der Owner darf schreiben; andere lesen live mit (R6/R10). Die Seite
 * meldet dem ChatPageModel nur Betreten und Verlassen — der Rest ist Ableitung.
 */
export const ChatPage = observer(function ChatPage({
  model,
  projectsStore,
  chatStore,
  speechStore,
}: ChatPageProps): JSX.Element {
  const { id } = useParams<{ id: string }>();

  useEffect(() => {
    if (id === undefined) return;
    model.open(id);
    return () => model.close();
  }, [model, id]);

  const project = model.project;

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ChatToolbar model={model} projectsStore={projectsStore} chatStore={chatStore} />

      {projectsStore.error !== null && (
        <Alert severity="error" data-testselector="chat-error">
          {projectsStore.error}
        </Alert>
      )}
      {model.projectMissing && (
        <Alert severity="warning" data-testselector="chat-project-missing">
          Projekt wurde nicht gefunden.
        </Alert>
      )}

      {/* Schmal (Phone/gefaltet): vertikal stapeln — column-reverse legt die
          Preview OBEN und den Chat UNTEN (Eingabe in Daumenreichweite). Breit:
          nebeneinander (Chat links, Preview rechts). */}
      <Stack
        direction={{ xs: 'column-reverse', md: 'row' }}
        spacing={2}
        sx={{ flexGrow: 1, minHeight: 0, p: 2 }}
      >
        <Paper
          variant="outlined"
          sx={{
            flex: 1,
            display: model.chatCollapsed ? 'none' : 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
          }}
          data-testselector="chat-column"
        >
          <ChatMessageList model={model} chatStore={chatStore} />

          {chatStore.turnActive && (
            <Box data-testselector="chat-turn-indicator">
              <LinearProgress />
            </Box>
          )}

          <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
            {chatStore.error !== null && (
              <Alert severity="error" sx={{ mb: 1 }} data-testselector="chat-send-error">
                {chatStore.error}
              </Alert>
            )}
            {project !== null && model.readOnly ? (
              <Alert severity="info" data-testselector="chat-readonly-hint">
                Nur-Lese-Modus — Projekt von {project.owner.username}
              </Alert>
            ) : (
              <ChatComposer chatStore={chatStore} speechStore={speechStore} />
            )}
          </Box>
        </Paper>

        <PreviewPane model={model} />
      </Stack>
    </Box>
  );
});
