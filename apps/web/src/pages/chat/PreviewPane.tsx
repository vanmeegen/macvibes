import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { observer } from 'mobx-react-lite';
import type { ChatPageModel } from '../../models/ChatPageModel';
import type { JSX } from 'react';

/** Preview-Spalte: iframe aufs Preview-Gateway oder ein Overlay mit dem Status. */
export const PreviewPane = observer(function PreviewPane({
  model,
}: {
  model: ChatPageModel;
}): JSX.Element {
  const preview = model.preview;
  return (
    <Paper
      variant="outlined"
      sx={{
        flex: 1,
        // Auf allen Größen sichtbar (früher xs:none → auf dem Phone nie zu
        // sehen); nur der Preview-Toggle blendet sie aus.
        display: model.previewCollapsed ? 'none' : 'flex',
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
          // Der Inhalt stammt vom Agenten und ist nicht vertrauenswürdig
          // (F13). allow-same-origin ist nötig für HMR-WebSocket und
          // localStorage der Preview; bewusst NICHT gesetzt sind
          // allow-top-navigation und allow-popups-to-escape-sandbox —
          // sonst könnte die Preview die macvibes-Seite wegnavigieren.
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
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
          data-status={model.project?.previewStatus ?? 'stopped'}
        >
          <Stack spacing={2} sx={{ alignItems: 'center' }}>
            {preview.spinner && <LinearProgress sx={{ width: 160 }} />}
            <Typography variant="body1" color="textSecondary">
              {preview.message}
            </Typography>
          </Stack>
        </Box>
      )}
    </Paper>
  );
});
