import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import AppBar from '@mui/material/AppBar';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { observer } from 'mobx-react-lite';
import type { ChatPageModel } from '../../models/ChatPageModel';
import type { ChatStore } from '../../models/ChatStore';
import type { ProjectsStore } from '../../models/ProjectsStore';
import { BackButton } from '../components/BackButton';
import { StatusChip } from '../components/StatusChip';
import type { JSX } from 'react';

/** Kopfzeile der Chat-Seite: Projektname, Modellwahl, Status, Preview-/Chat-Schalter. */
export const ChatToolbar = observer(function ChatToolbar({
  model,
  projectsStore,
  chatStore,
}: {
  model: ChatPageModel;
  projectsStore: ProjectsStore;
  chatStore: ChatStore;
}): JSX.Element {
  const project = model.project;
  const previewUrl = model.preview.url;
  return (
    <AppBar position="static">
      <Toolbar>
        <BackButton testselector="chat-back-button" />
        <Typography variant="h5" component="h1" sx={{ flexGrow: 1 }} noWrap>
          {project?.name ?? 'Projekt'}
        </Typography>
        {/* Modellwahl pro Chat (nur Owner): der NÄCHSTE Turn nutzt das neue
            Modell, die Claude-Session startet dabei frisch. */}
        {project !== null && model.showModelSelect && (
          <TextField
            select
            size="small"
            value={project.agentModel}
            onChange={(event) => {
              void projectsStore.setProjectModel(project.id, event.target.value);
            }}
            sx={{ mr: 2, minWidth: 200, display: { xs: 'none', sm: 'block' } }}
            // Testselektor auf dem SICHTBAREN Select-Element (klickbar in E2E);
            // slotProps.htmlInput landet beim MUI-Select nur auf dem versteckten Input.
            slotProps={{
              select: {
                SelectDisplayProps: {
                  'data-testselector': 'chat-model-select',
                } as React.HTMLAttributes<HTMLDivElement>,
              },
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
          // aus der Projektliste hinkt hier hinterher (Polling).
          <StatusChip
            sandboxStatus={project.sandboxStatus}
            turnActive={chatStore.turnActive}
            testselector="chat-sandbox-status"
            sx={{ mr: 2 }}
          />
        )}
        {project !== null && (
          <Typography
            variant="body2"
            color="textSecondary"
            // Auf schmalen Screens ausblenden, damit die Toggle-Icons rechts
            // sichtbar bleiben (Toolbar-Überlauf, Phone).
            sx={{ display: { xs: 'none', sm: 'block' } }}
          >
            von {project.owner.username}
          </Typography>
        )}
        {previewUrl !== null && (
          <IconButton
            component="a"
            href={previewUrl}
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
          onClick={model.togglePreviewCollapsed}
          aria-label={model.previewCollapsed ? 'Preview anzeigen' : 'Preview ausblenden'}
          sx={{ ml: 1 }}
          data-testselector="chat-preview-toggle"
        >
          {model.previewCollapsed ? <VisibilityIcon /> : <VisibilityOffIcon />}
        </IconButton>
        <IconButton
          onClick={model.toggleChatCollapsed}
          aria-label={model.chatCollapsed ? 'Chat einblenden' : 'Chat ausblenden'}
          sx={{ ml: 1 }}
          data-testselector="chat-collapse-toggle"
        >
          {model.chatCollapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
        </IconButton>
      </Toolbar>
    </AppBar>
  );
});
