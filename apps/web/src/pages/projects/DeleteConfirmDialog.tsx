import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import { observer } from 'mobx-react-lite';
import type { ProjectsStore } from '../../models/ProjectsStore';

/** Rückfrage vor dem Löschen eines Projekts. */
export const DeleteConfirmDialog = observer(function DeleteConfirmDialog({
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
