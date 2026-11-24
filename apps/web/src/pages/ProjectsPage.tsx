import AddIcon from '@mui/icons-material/Add';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Fab from '@mui/material/Fab';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { observer } from 'mobx-react-lite';
import type { MouseEvent } from 'react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AuthStore } from '../models/AuthStore';
import type { CreateProjectModel } from '../models/CreateProjectModel';
import type { ProjectFilter, ProjectsStore } from '../models/ProjectsStore';
import { CreateProjectDialog } from './projects/CreateProjectDialog';
import { DeleteConfirmDialog } from './projects/DeleteConfirmDialog';
import { CopyProjectDialog, RenameProjectDialog } from './projects/NameDialog';
import { ProjectCard } from './projects/ProjectCard';

interface ProjectsPageProps {
  authStore: AuthStore;
  projectsStore: ProjectsStore;
  createProjectModel: CreateProjectModel;
}

/**
 * Projektübersicht: Filter "Nur meine" / "Alle", Projekt-Karten, Anlegen (FAB)
 * sowie die Dialoge zum Kopieren, Umbenennen und Löschen.
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

        {authStore.error !== null && (
          <Alert
            severity="error"
            sx={{ mb: 3 }}
            onClose={authStore.clearError}
            data-testselector="auth-error"
          >
            {authStore.error}
          </Alert>
        )}
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
      <CopyProjectDialog
        projectsStore={projectsStore}
        onCopied={(projectId) => navigate(`/projects/${projectId}`)}
      />
      <RenameProjectDialog projectsStore={projectsStore} />
      <DeleteConfirmDialog projectsStore={projectsStore} />
    </Box>
  );
});
