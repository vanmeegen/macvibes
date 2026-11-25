import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { observer } from 'mobx-react-lite';
import type { CreateProjectModel } from '../../models/CreateProjectModel';
import type { ProjectsStore } from '../../models/ProjectsStore';
import type { JSX } from 'react';

/** Dialog „Neues Projekt": Name und Vorlage. */
export const CreateProjectDialog = observer(function CreateProjectDialog({
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
