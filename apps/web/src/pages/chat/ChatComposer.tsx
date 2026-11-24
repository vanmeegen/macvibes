import MicIcon from '@mui/icons-material/Mic';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { observer } from 'mobx-react-lite';
import type { ChatStore } from '../../models/ChatStore';
import type { SpeechStore } from '../../models/SpeechStore';

/** Pulsieren des Mikro-Buttons während der Aufnahme. */
const RECORDING_PULSE = {
  '@keyframes micPulse': {
    '0%': { opacity: 1 },
    '50%': { opacity: 0.4 },
    '100%': { opacity: 1 },
  },
  animation: 'micPulse 1.2s ease-in-out infinite',
};

/**
 * Eingabezeile mit Diktat, Stop und Senden. Eigener Observer: ein Tastendruck
 * (Entwurf) rendert nur die Eingabe neu, nicht die Nachrichtenliste.
 */
export const ChatComposer = observer(function ChatComposer({
  chatStore,
  speechStore,
}: {
  chatStore: ChatStore;
  speechStore: SpeechStore;
}): JSX.Element {
  return (
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
        <Tooltip title={speechStore.tooltip}>
          {/* span: Tooltips brauchen bei disabled-Buttons einen Wrapper */}
          <span>
            <IconButton
              aria-label={speechStore.micLabel}
              color={speechStore.isRecording ? 'error' : 'default'}
              disabled={!speechStore.canRecord}
              onClick={() => void speechStore.toggle()}
              data-testselector="chat-mic"
              data-status={speechStore.status}
              sx={speechStore.isRecording ? RECORDING_PULSE : {}}
            >
              {speechStore.status === 'installing' ? <CircularProgress size={20} /> : <MicIcon />}
            </IconButton>
          </span>
        </Tooltip>
        {speechStore.canRecord && (
          <Tooltip title="Diktiersprache umschalten">
            <Chip
              size="small"
              label={speechStore.langLabel}
              onClick={speechStore.toggleLang}
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
          disabled={!chatStore.canSend}
          onClick={() => void chatStore.send()}
          data-testselector="chat-send"
        >
          <SendIcon />
        </IconButton>
      </Stack>
      {speechStore.showInterim && (
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
  );
});
