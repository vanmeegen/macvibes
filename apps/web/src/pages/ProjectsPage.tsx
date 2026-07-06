import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Fab from '@mui/material/Fab';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { observer } from 'mobx-react-lite';
import type { MouseEvent } from 'react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Project } from '../api/types';
import type { AuthStore } from '../models/AuthStore';
import type { CreateProjectModel } from '../models/CreateProjectModel';
import type { ProjectFilter, ProjectsStore } from '../models/ProjectsStore';
import { formatTimestamp, sandboxStatusLabel } from '../models/ProjectsStore';

export interface ProjectsPageProps {
  authStore: AuthStore;
  projectsStore: ProjectsStore;
  createProjectModel: CreateProjectModel;
}

const ProjectCard = observer(function ProjectCard({
  project,
  projectsStore,
}: {
  project: Project;
  projectsStore: ProjectsStore;
}): JSX.Element {
  const navigate = useNavigate();

  const handleDelete = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    event.preventDefault();
    projectsStore.requestDelete(project.id);
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
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
              <Typography variant="h5" component="h2" noWrap>
                {project.name}
              </Typography>
              <Chip
                size="small"
                label={sandboxStatusLabel(project.sandboxStatus)}
                color={project.sandboxStatus === 'running' ? 'success' : 'default'}
                variant="outlined"
                data-testselector={`project-status-${project.id}`}
                data-status={project.sandboxStatus}
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
      {projectsStore.isOwn(project) && (
        <IconButton
          aria-label="Projekt löschen"
          size="small"
          onClick={handleDelete}
          sx={{ position: 'absolute', right: 8, bottom: 8 }}
          data-testselector={`project-delete-${project.id}`}
        >
          <DeleteIcon fontSize="small" />
        </IconButton>
      )}
    </Card>
  );
});

const CreateProjectDialog = observer(function CreateProjectDialog({
  model,
  projectsStore,
  onCreated,
}: {
  model: CreateProjectModel;
  projectsStore: ProjectsStore;
  /** Nach erfolgreicher Anlage: direkt in den Chat des neuen Projekts. */
  onCreated: (projectId: string) => void;
}): JSX.Element {
  const submitAndOpenChat = async (): Promise<void> => {
    const projectId = await model.submit();
    if (projectId !== null) {
      onCreated(projectId);
    }
  };
  return (
    // disableRestoreFocus: sonst klaut MUIs Focus-Restore dem Namensfeld den
    // Autofokus beim Öffnen des Dialogs.
    <Dialog open={model.open} onClose={model.close} fullWidth maxWidth="sm" disableRestoreFocus>
      <DialogTitle>Neues Projekt</DialogTitle>
      <DialogContent>
        <Stack spacing={3} sx={{ mt: 1 }}>
          {model.error !== null && (
            <Alert severity="error" data-testselector="new-project-error">
              {model.error}
            </Alert>
          )}
          <TextField
            label="Projektname"
            value={model.name}
            onChange={(e) => model.setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && model.canSubmit) {
                e.preventDefault();
                void submitAndOpenChat();
              }
            }}
            autoFocus
            inputProps={{ 'data-testselector': 'new-project-name' }}
          />
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Vorlage
            </Typography>
            <RadioGroup
              value={model.selectedTemplateDir}
              onChange={(e) => model.setSelectedTemplateDir(e.target.value)}
            >
              {projectsStore.templates.map((template) => (
                <FormControlLabel
                  key={template.dir}
                  value={template.dir}
                  control={
                    <Radio
                      inputProps={
                        {
                          'data-testselector': `template-option-${template.dir}`,
                        } as React.InputHTMLAttributes<HTMLInputElement>
                      }
                    />
                  }
                  label={
                    <Box sx={{ py: 0.5 }}>
                      <Typography variant="body1">{template.name}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {template.description}
                      </Typography>
                    </Box>
                  }
                />
              ))}
            </RadioGroup>
            {projectsStore.templates.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                Keine Vorlagen verfügbar.
              </Typography>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={model.close} color="inherit">
          Abbrechen
        </Button>
        <Button
          variant="contained"
          onClick={() => void submitAndOpenChat()}
          disabled={!model.canSubmit}
          data-testselector="new-project-submit"
        >
          Erstellen
        </Button>
      </DialogActions>
    </Dialog>
  );
});

const DeleteConfirmDialog = observer(function DeleteConfirmDialog({
  projectsStore,
}: {
  projectsStore: ProjectsStore;
}): JSX.Element {
  const project = projectsStore.pendingDeleteProject;
  return (
    <Dialog open={project !== null} onClose={projectsStore.cancelDelete}>
      <DialogTitle>Projekt löschen?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Soll das Projekt „{project?.name ?? ''}“ wirklich gelöscht werden? Diese Aktion kann nicht
          rückgängig gemacht werden.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button
          onClick={projectsStore.cancelDelete}
          color="inherit"
          data-testselector="delete-cancel"
        >
          Abbrechen
        </Button>
        <Button
          color="error"
          variant="contained"
          onClick={() => void projectsStore.confirmDelete()}
          data-testselector="delete-confirm"
        >
          Löschen
        </Button>
      </DialogActions>
    </Dialog>
  );
});

/**
 * Projektübersicht: Filter "Nur meine" / "Alle", Projekt-Karten,
 * Anlegen-Dialog (FAB) und Lösch-Bestätigung.
 */
export const ProjectsPage = observer(function ProjectsPage({
  authStore,
  projectsStore,
  createProjectModel,
}: ProjectsPageProps): JSX.Element {
  const navigate = useNavigate();
  useEffect(() => {
    void projectsStore.load();
    projectsStore.startPolling();
    return () => projectsStore.stopPolling();
  }, [projectsStore]);

  const handleFilterChange = (
    _event: MouseEvent<HTMLElement>,
    value: ProjectFilter | null,
  ): void => {
    if (value !== null) {
      projectsStore.setFilter(value);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', pb: 12 }}>
      <AppBar position="sticky">
        <Toolbar>
          <Typography variant="h5" component="h1" color="primary" sx={{ flexGrow: 1 }}>
            macvibes
          </Typography>
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="body2" color="text.secondary" data-testselector="current-username">
              {authStore.currentUser?.username ?? ''}
            </Typography>
            {authStore.isAdmin && (
              <Button
                color="inherit"
                variant="outlined"
                size="small"
                onClick={() => navigate('/admin')}
                data-testselector="admin-link"
              >
                Nutzer verwalten
              </Button>
            )}
            <Button
              color="inherit"
              variant="outlined"
              size="small"
              onClick={() => void authStore.logout()}
              data-testselector="logout-button"
            >
              Abmelden
            </Button>
          </Stack>
        </Toolbar>
      </AppBar>

      <Box sx={{ maxWidth: 1200, mx: 'auto', px: 3, pt: 3 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 3 }}>
          <Typography variant="h3" component="h2">
            Projekte
          </Typography>
          <ToggleButtonGroup
            value={projectsStore.filter}
            exclusive
            onChange={handleFilterChange}
            size="small"
          >
            <ToggleButton value="mine" data-testselector="project-filter-mine">
              Nur meine
            </ToggleButton>
            <ToggleButton value="all" data-testselector="project-filter-all">
              Alle
            </ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        {projectsStore.error !== null && (
          <Alert severity="error" sx={{ mb: 3 }} data-testselector="projects-error">
            {projectsStore.error}
          </Alert>
        )}

        {projectsStore.loading && projectsStore.projects.length === 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
            <CircularProgress />
          </Box>
        ) : (
          <Grid container spacing={3}>
            {projectsStore.visibleProjects.map((project) => (
              <Grid item xs={12} sm={6} md={4} key={project.id}>
                <ProjectCard project={project} projectsStore={projectsStore} />
              </Grid>
            ))}
            {projectsStore.visibleProjects.length === 0 && !projectsStore.loading && (
              <Grid item xs={12}>
                <Typography
                  variant="body1"
                  color="text.secondary"
                  sx={{ py: 6, textAlign: 'center' }}
                >
                  Noch keine Projekte vorhanden. Lege mit dem Plus-Button dein erstes Projekt an.
                </Typography>
              </Grid>
            )}
          </Grid>
        )}
      </Box>

      <Fab
        color="primary"
        aria-label="Neues Projekt"
        onClick={createProjectModel.openDialog}
        sx={{ position: 'fixed', right: 32, bottom: 32 }}
        data-testselector="new-project-fab"
      >
        <AddIcon />
      </Fab>

      <CreateProjectDialog
        model={createProjectModel}
        projectsStore={projectsStore}
        onCreated={(projectId) => navigate(`/projects/${projectId}`)}
      />
      <DeleteConfirmDialog projectsStore={projectsStore} />
    </Box>
  );
});
