import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { observer } from 'mobx-react-lite';
import type { JSX, MouseEvent } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Project } from '../../api/types';
import { formatTimestamp } from '../../models/projectPresentation';
import type { ProjectsStore } from '../../models/ProjectsStore';
import { StatusChip } from '../components/StatusChip';

/** Projektkarte: Name, Status, Eigentümer und das Kartenmenü. */
export const ProjectCard = observer(function ProjectCard({
  project,
  projectsStore,
}: {
  project: Project;
  projectsStore: ProjectsStore;
}): JSX.Element {
  const navigate = useNavigate();
  // Anker des Karten-Menüs — reiner View-Zustand (DOM-Referenz), daher lokal.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const canManage = projectsStore.canManage(project);

  const handleMenuOpen = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    event.preventDefault();
    setMenuAnchor(event.currentTarget);
  };

  return (
    <Card
      sx={{ height: '100%', position: 'relative' }}
      data-testselector={`project-card-${project.id}`}
    >
      <CardActionArea
        onClick={() => navigate(`/projects/${project.id}`)}
        sx={{ height: '100%', alignItems: 'stretch' }}
        data-testselector={`project-card-link-${project.id}`}
      >
        <CardContent>
          <Stack spacing={1}>
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center', justifyContent: 'space-between' }}
            >
              <Typography variant="h5" component="h2" noWrap>
                {project.name}
              </Typography>
              <StatusChip
                sandboxStatus={project.sandboxStatus}
                turnActive={project.turnActive}
                testselector={`project-status-${project.id}`}
              />
            </Stack>
            <Typography variant="body2" color="text.secondary">
              von {project.owner.username}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Vorlage: {project.templateDir}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Letzte Aktivität: {formatTimestamp(project.lastActivityAt)}
            </Typography>
          </Stack>
        </CardContent>
      </CardActionArea>
      <IconButton
        aria-label="Projektmenü"
        size="small"
        onClick={handleMenuOpen}
        sx={{ position: 'absolute', right: 8, bottom: 8 }}
        data-testselector={`project-menu-${project.id}`}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu anchorEl={menuAnchor} open={menuAnchor !== null} onClose={() => setMenuAnchor(null)}>
        {/* Kopieren darf JEDER — der Fork landet im eigenen Namensraum. */}
        <MenuItem
          onClick={() => {
            setMenuAnchor(null);
            projectsStore.requestCopy(project.id);
          }}
          data-testselector={`project-copy-${project.id}`}
        >
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Kopieren und Anpassen</ListItemText>
        </MenuItem>
        {canManage && (
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              projectsStore.requestRename(project.id);
            }}
            data-testselector={`project-rename-${project.id}`}
          >
            <ListItemIcon>
              <EditIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Umbenennen</ListItemText>
          </MenuItem>
        )}
        {canManage && (
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              projectsStore.requestDelete(project.id);
            }}
            data-testselector={`project-delete-${project.id}`}
          >
            <ListItemIcon>
              <DeleteIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Löschen</ListItemText>
          </MenuItem>
        )}
      </Menu>
    </Card>
  );
});
