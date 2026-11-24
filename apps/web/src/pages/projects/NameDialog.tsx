import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import { observer } from 'mobx-react-lite';
import type { NameDialogModel } from '../../models/NameDialogModel';
import type { ProjectsStore } from '../../models/ProjectsStore';

/**
 * Dialog „Namen eingeben" zu einem Projekt — gemeinsame Darstellung für
 * Kopieren und Umbenennen. `testPrefix` bildet die Testselektoren
 * (`<prefix>-project-name`, `-project-error`, `-cancel`, `-confirm`).
 */
export const NameDialog = observer(function NameDialog({
  dialog,
  open,
  title,
  hint,
  fieldLabel,
  confirmLabel,
  testPrefix,
  onConfirm,
}: {
  dialog: NameDialogModel;
  open: boolean;
  title: string;
  hint?: string;
  fieldLabel: string;
  confirmLabel: string;
  testPrefix: string;
  onConfirm: () => void;
}): JSX.Element {
  return (
    // disableRestoreFocus: sonst klaut MUIs Focus-Restore dem Namensfeld den
    // Autofokus beim Öffnen des Dialogs.
    <Dialog open={open} onClose={dialog.cancel} fullWidth maxWidth="sm" disableRestoreFocus>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {hint !== undefined && <DialogContentText>{hint}</DialogContentText>}
          {dialog.error !== null && (
            <Alert severity="error" data-testselector={`${testPrefix}-project-error`}>
              {dialog.error}
            </Alert>
          )}
          <TextField
            label={fieldLabel}
            value={dialog.name}
            onChange={(e) => dialog.setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && dialog.canConfirm) {
                e.preventDefault();
                onConfirm();
              }
            }}
            autoFocus
            inputProps={{ 'data-testselector': `${testPrefix}-project-name` }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={dialog.cancel} color="inherit" data-testselector={`${testPrefix}-cancel`}>
          Abbrechen
        </Button>
        <Button
          variant="contained"
          onClick={onConfirm}
          disabled={!dialog.canConfirm}
          data-testselector={`${testPrefix}-confirm`}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
});

/** „Kopieren und Anpassen": Fork unter eigenem Namen. */
export const CopyProjectDialog = observer(function CopyProjectDialog({
  projectsStore,
  onCopied,
}: {
  projectsStore: ProjectsStore;
  /** Nach erfolgreichem Fork: direkt in den Chat des neuen Projekts. */
  onCopied: (projectId: string) => void;
}): JSX.Element {
  const project = projectsStore.pendingCopyProject;
  const submit = async (): Promise<void> => {
    const projectId = await projectsStore.confirmCopy();
    if (projectId !== null) {
      onCopied(projectId);
    }
  };
  return (
    <NameDialog
      dialog={projectsStore.copyDialog}
      open={project !== null}
      title={`„${project?.name ?? ''}" kopieren und anpassen`}
      hint="Legt ein neues Projekt unter deinem Namen an — aufsetzend auf dem aktuellen Entwicklungsstand des Originals (das Original bleibt unberührt)."
      fieldLabel="Name des neuen Projekts"
      confirmLabel="Kopieren"
      testPrefix="copy"
      onConfirm={() => void submit()}
    />
  );
});

export const RenameProjectDialog = observer(function RenameProjectDialog({
  projectsStore,
}: {
  projectsStore: ProjectsStore;
}): JSX.Element {
  return (
    <NameDialog
      dialog={projectsStore.renameDialog}
      open={projectsStore.pendingRenameProject !== null}
      title="Projekt umbenennen"
      fieldLabel="Projektname"
      confirmLabel="Umbenennen"
      testPrefix="rename"
      onConfirm={() => void projectsStore.confirmRename()}
    />
  );
});
