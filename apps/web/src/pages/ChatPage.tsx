import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import SendIcon from '@mui/icons-material/Send';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ProjectsStore } from '../models/ProjectsStore';

export interface ChatPageProps {
  projectsStore: ProjectsStore;
}

/**
 * Phase-A-Hülle der Projektansicht: zweispaltiges Layout mit
 * Chat-Platzhalter (links) und Preview-Platzhalter (rechts).
 * Der Besitzvergleich (Nur-Lese-Modus) läuft über projectsStore.isOwn,
 * das intern den AuthStore nutzt.
 */
export const ChatPage = observer(function ChatPage({ projectsStore }: ChatPageProps): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  useEffect(() => {
    if (projectsStore.projects.length === 0 && !projectsStore.loading) {
      void projectsStore.load();
    }
  }, [projectsStore]);

  const project = projectsStore.projects.find((p) => p.id === id) ?? null;
  const isOwner = project !== null && projectsStore.isOwn(project);

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppBar position="static">
        <Toolbar>
          <IconButton
            edge="start"
            aria-label="Zurück zur Projektübersicht"
            onClick={() => navigate('/')}
            sx={{ mr: 2 }}
            data-testselector="chat-back-button"
          >
            <ArrowBackIcon />
          </IconButton>
          <Typography variant="h5" component="h1" sx={{ flexGrow: 1 }} noWrap>
            {project?.name ?? 'Projekt'}
          </Typography>
          {project !== null && (
            <Typography variant="body2" color="text.secondary">
              von {project.owner.username}
            </Typography>
          )}
        </Toolbar>
      </AppBar>

      {projectsStore.error !== null && (
        <Alert severity="error" data-testselector="chat-error">
          {projectsStore.error}
        </Alert>
      )}
      {project === null && !projectsStore.loading && projectsStore.error === null && (
        <Alert severity="warning" data-testselector="chat-project-missing">
          Projekt wurde nicht gefunden.
        </Alert>
      )}

      <Stack direction="row" spacing={2} sx={{ flexGrow: 1, minHeight: 0, p: 2 }}>
        <Paper
          variant="outlined"
          sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}
        >
          <Box
            sx={{
              flexGrow: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              p: 3,
            }}
          >
            <Typography variant="body1" color="text.secondary">
              Chat folgt in Phase B
            </Typography>
          </Box>
          <Box sx={{ p: 2, borderTop: 1, borderColor: 'divider' }}>
            {project !== null && !isOwner ? (
              <Alert severity="info" data-testselector="chat-readonly-hint">
                Nur-Lese-Modus — Projekt von {project.owner.username}
              </Alert>
            ) : (
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField
                  placeholder="Nachricht an den Agenten …"
                  disabled
                  size="small"
                  inputProps={{ 'data-testselector': 'chat-input' }}
                />
                <IconButton disabled aria-label="Senden" data-testselector="chat-send">
                  <SendIcon />
                </IconButton>
              </Stack>
            )}
          </Box>
        </Paper>

        <Paper
          variant="outlined"
          sx={{
            flex: 1,
            display: { xs: 'none', md: 'flex' },
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 0,
          }}
        >
          <Typography variant="body1" color="text.secondary">
            Preview folgt in Phase B
          </Typography>
        </Paper>
      </Stack>
    </Box>
  );
});
