import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import MicIcon from '@mui/icons-material/Mic';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ChatMessage } from '../api/types';
import type { ChatStore } from '../models/ChatStore';
import { derivePreviewView } from '../models/PreviewModel';
import { agentWorkingLabel, projectStatusChip, type ProjectsStore } from '../models/ProjectsStore';
import type { SpeechStore } from '../models/SpeechStore';

export interface ChatPageProps {
  projectsStore: ProjectsStore;
  chatStore: ChatStore;
  speechStore: SpeechStore;
}

/** Tooltip des Mikro-Buttons je nach Verfügbarkeit/Status. */
function micTooltip(speechStore: SpeechStore): string {
  switch (speechStore.availability) {
    case 'insecure':
      return (
        'Diktat braucht einen sicheren Kontext. Auf dem Mac localhost verwenden; ' +
        'im LAN einmalig chrome://flags/#unsafely-treat-insecure-origin-as-secure ' +
        'für diese Adresse aktivieren.'
      );
    case 'unsupported':
      return 'Lokale Spracherkennung braucht Chrome/Chromium 139+.';
    case 'unavailable':
      return 'Für diese Sprache ist keine lokale Erkennung verfügbar.';
    default:
      break;
  }
  if (speechStore.status === 'recording') return 'Aufnahme stoppen';
  if (speechStore.status === 'installing') return 'Sprachpaket wird installiert …';
  return 'Diktieren — läuft komplett lokal im Browser';
}

const MessageBubble = observer(function MessageBubble({
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

/**
 * Projektansicht: Chat mit dem Agenten (links) und Preview (rechts).
 * Nur der Owner darf schreiben; andere lesen live mit (R6/R10).
 */
export const ChatPage = observer(function ChatPage({
  projectsStore,
  chatStore,
  speechStore,
}: ChatPageProps): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Grundvoraussetzungen fürs Diktat prüfen — bewusst nur synchrone Checks;
  // die echte available()-Probe passiert erst beim Klick (Chromium-Crash-Bug
  // auf macOS, s. SpeechStore).
  useEffect(() => {
    speechStore.init();
  }, [speechStore]);

  useEffect(() => {
    if (projectsStore.projects.length === 0 && !projectsStore.loading) {
      void projectsStore.load();
    }
  }, [projectsStore]);

  const project = projectsStore.projects.find((p) => p.id === id) ?? null;
  const isOwner = project !== null && projectsStore.isOwn(project);
  const projectId = project?.id ?? null;

  // Status live halten — auch für Nur-Lese-Besucher.
  useEffect(() => {
    projectsStore.startPolling(1000);
    return () => projectsStore.stopPolling();
  }, [projectsStore]);

  // Öffnen startet die Sandbox, Verlassen startet die Grace-Period (R9, nur Owner).
  useEffect(() => {
    if (projectId === null || !isOwner) return;
    void projectsStore.enterProject(projectId);
    return () => {
      void projectsStore.leaveProject(projectId);
    };
  }, [projectsStore, projectId, isOwner]);

  // Chat-Historie + Live-Stream (alle angemeldeten Besucher, R10).
  useEffect(() => {
    if (projectId === null) return;
    void chatStore.connect(projectId);
    return () => chatStore.disconnect();
  }, [chatStore, projectId]);

  // Live-Preview: aus dem autoritativen Watchdog-Status des Backends abgeleitet
  // (starting/ready/restarting/failed) — kein eigenes Polling mehr (R7). Die
  // iframe-URL zeigt aufs Preview-Gateway (fester Port, /p/<projectId>/), nicht
  // auf den dynamischen VM-Port — nur so ist die Preview über Remote/VPN erreichbar.
  const preview = derivePreviewView(
    project?.previewStatus ?? 'stopped',
    typeof window !== 'undefined' ? window.location.hostname : 'localhost',
    project?.sandboxStatus === 'running' ? projectsStore.previewGatewayPort : null,
    projectId,
  );

  // Immer ans Ende scrollen, wenn neue Events eintreffen.
  const messageCount = chatStore.messages.length;
  const lastContentLength = chatStore.messages[messageCount - 1]?.content.length ?? 0;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messageCount, lastContentLength]);

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
          {/* Modellwahl pro Chat (nur Owner): der NÄCHSTE Turn nutzt das neue
              Modell, die Claude-Session startet dabei frisch. */}
          {project !== null && isOwner && projectsStore.agentModels.length > 0 && (
            <TextField
              select
              size="small"
              value={project.agentModel}
              onChange={(event) => {
                void projectsStore.setProjectModel(project.id, event.target.value);
              }}
              sx={{ mr: 2, minWidth: 200, display: { xs: 'none', sm: 'block' } }}
              // Testselektor auf dem SICHTBAREN Select-Element (klickbar in E2E);
              // inputProps landet beim MUI-Select nur auf dem versteckten Input.
              SelectProps={{
                SelectDisplayProps: {
                  'data-testselector': 'chat-model-select',
                } as React.HTMLAttributes<HTMLDivElement>,
              }}
            >
              {projectsStore.agentModels.map((m) => (
                <MenuItem key={m.id} value={m.id} data-testselector={`chat-model-option-${m.id}`}>
                  {m.label}
                </MenuItem>
              ))}
            </TextField>
          )}
          {project !== null && (
            // turnActive live aus dem ChatStore (Subscription) — Project.turnActive
            // aus der Projektliste hinkt hier hinterher (2-s-Polling).
            <Chip
              size="small"
              label={projectStatusChip(project.sandboxStatus, chatStore.turnActive).label}
              color={projectStatusChip(project.sandboxStatus, chatStore.turnActive).color}
              variant="outlined"
              sx={{ mr: 2 }}
              data-testselector="chat-sandbox-status"
              data-status={project.sandboxStatus}
              data-turn-active={chatStore.turnActive ? 'true' : 'false'}
            />
          )}
          {project !== null && (
            <Typography
              variant="body2"
              color="text.secondary"
              // Auf schmalen Screens ausblenden, damit die Toggle-Icons rechts
              // sichtbar bleiben (Toolbar-Überlauf, Phone).
              sx={{ display: { xs: 'none', sm: 'block' } }}
            >
              von {project.owner.username}
            </Typography>
          )}
          {preview.url !== null && (
            <IconButton
              component="a"
              href={preview.url}
              target="_blank"
              rel="noopener"
              aria-label="Preview in neuem Tab öffnen"
              sx={{ ml: 1 }}
              data-testselector="chat-preview-open"
            >
              <OpenInNewIcon />
            </IconButton>
          )}
          <IconButton
            onClick={chatStore.togglePreviewCollapsed}
            aria-label={chatStore.previewCollapsed ? 'Preview anzeigen' : 'Preview ausblenden'}
            sx={{ ml: 1 }}
            data-testselector="chat-preview-toggle"
          >
            {chatStore.previewCollapsed ? <VisibilityIcon /> : <VisibilityOffIcon />}
          </IconButton>
          <IconButton
            onClick={chatStore.toggleChatCollapsed}
            aria-label={chatStore.chatCollapsed ? 'Chat einblenden' : 'Chat ausblenden'}
            sx={{ ml: 1 }}
            data-testselector="chat-collapse-toggle"
          >
            {chatStore.chatCollapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
          </IconButton>
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
            display: chatStore.chatCollapsed ? 'none' : 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
          }}
          data-testselector="chat-column"
        >
          <Box
            ref={scrollRef}
            sx={{ flexGrow: 1, overflowY: 'auto', p: 2, display: 'flex', flexDirection: 'column' }}
          >
            <Stack spacing={1.5}>
              {chatStore.messages.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
                  Noch keine Nachrichten — beschreibe dem Agenten, was er bauen soll.
                </Typography>
              )}
              {chatStore.messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
              {chatStore.turnActive &&
                !['assistant', 'thinking'].includes(
                  chatStore.messages[chatStore.messages.length - 1]?.role ?? '',
                ) && (
                  <Box
                    sx={{ display: 'flex', justifyContent: 'flex-start' }}
                    data-testselector="chat-working"
                  >
                    <Paper variant="outlined" sx={{ px: 2, py: 1 }}>
                      <Stack direction="row" spacing={1.5} alignItems="center">
                        <CircularProgress size={14} />
                        <Typography variant="body2" color="text.secondary">
                          {agentWorkingLabel(project?.sandboxStatus ?? 'running')}
                        </Typography>
                      </Stack>
                    </Paper>
                  </Box>
                )}
            </Stack>
          </Box>

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
            {project !== null && !isOwner ? (
              <Alert severity="info" data-testselector="chat-readonly-hint">
                Nur-Lese-Modus — Projekt von {project.owner.username}
              </Alert>
            ) : (
              <>
                <Stack direction="row" spacing={1} alignItems="center">
                  <TextField
                    placeholder="Nachricht an den Agenten …"
                    size="small"
                    fullWidth
                    multiline
                    maxRows={6}
                    value={chatStore.draft}
                    onChange={(e) => chatStore.setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void chatStore.send();
                      }
                    }}
                    inputProps={{ 'data-testselector': 'chat-input' }}
                  />
                  {/* Diktat: lokale Erkennung im Browser (Chrome On-Device). */}
                  <Tooltip title={micTooltip(speechStore)}>
                    {/* span: Tooltips brauchen bei disabled-Buttons einen Wrapper */}
                    <span>
                      <IconButton
                        aria-label={
                          speechStore.status === 'recording' ? 'Aufnahme stoppen' : 'Diktieren'
                        }
                        color={speechStore.status === 'recording' ? 'error' : 'default'}
                        disabled={!speechStore.canRecord}
                        onClick={() => void speechStore.toggle()}
                        data-testselector="chat-mic"
                        data-status={speechStore.status}
                        sx={
                          speechStore.status === 'recording'
                            ? {
                                '@keyframes micPulse': {
                                  '0%': { opacity: 1 },
                                  '50%': { opacity: 0.4 },
                                  '100%': { opacity: 1 },
                                },
                                animation: 'micPulse 1.2s ease-in-out infinite',
                              }
                            : {}
                        }
                      >
                        {speechStore.status === 'installing' ? (
                          <CircularProgress size={20} />
                        ) : (
                          <MicIcon />
                        )}
                      </IconButton>
                    </span>
                  </Tooltip>
                  {speechStore.canRecord && (
                    <Tooltip title="Diktiersprache umschalten">
                      <Chip
                        size="small"
                        label={speechStore.lang === 'de-DE' ? 'DE' : 'EN'}
                        onClick={() =>
                          speechStore.setLang(speechStore.lang === 'de-DE' ? 'en-US' : 'de-DE')
                        }
                        data-testselector="chat-mic-lang"
                      />
                    </Tooltip>
                  )}
                  {chatStore.turnActive && (
                    <IconButton
                      aria-label="Turn abbrechen"
                      color="error"
                      onClick={() => void chatStore.stop()}
                      data-testselector="chat-stop"
                    >
                      <StopIcon />
                    </IconButton>
                  )}
                  <IconButton
                    aria-label="Senden"
                    color="primary"
                    disabled={chatStore.draft.trim().length === 0}
                    onClick={() => void chatStore.send()}
                    data-testselector="chat-send"
                  >
                    <SendIcon />
                  </IconButton>
                </Stack>
                {speechStore.status === 'recording' && speechStore.interimText.length > 0 && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ fontStyle: 'italic' }}
                    data-testselector="chat-mic-interim"
                  >
                    🎙 {speechStore.interimText}
                  </Typography>
                )}
                {speechStore.error !== null && (
                  <Typography variant="caption" color="error" data-testselector="chat-mic-error">
                    {speechStore.error}
                  </Typography>
                )}
              </>
            )}
          </Box>
        </Paper>

        <Paper
          variant="outlined"
          sx={{
            flex: 1,
            // Auf allen Größen sichtbar (früher xs:none → auf dem Phone nie zu
            // sehen); nur der Preview-Toggle blendet sie aus.
            display: chatStore.previewCollapsed ? 'none' : 'flex',
            flexDirection: 'column',
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
          }}
          data-testselector="preview-column"
        >
          {preview.showIframe && preview.url !== null ? (
            <Box
              component="iframe"
              src={preview.url}
              title="Live-Preview"
              data-testselector="chat-preview"
              sx={{ border: 0, width: '100%', height: '100%' }}
            />
          ) : (
            <Box
              sx={{
                flexGrow: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                p: 3,
              }}
              data-testselector="chat-preview-unavailable"
              data-status={project?.previewStatus ?? 'stopped'}
            >
              <Stack spacing={2} alignItems="center">
                {preview.spinner && <LinearProgress sx={{ width: 160 }} />}
                <Typography variant="body1" color="text.secondary">
                  {preview.message}
                </Typography>
              </Stack>
            </Box>
          )}
        </Paper>
      </Stack>
    </Box>
  );
});
