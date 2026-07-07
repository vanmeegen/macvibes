import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { observer } from 'mobx-react-lite';
import type { FormEvent, MouseEvent } from 'react';
import type { AuthStore } from '../models/AuthStore';
import type { LoginMode, LoginModel } from '../models/LoginModel';

export interface LoginPageProps {
  authStore: AuthStore;
  loginModel: LoginModel;
}

/**
 * Anmelde-/Registrierungsseite. Nach erfolgreicher Anmeldung setzt der
 * AuthStore currentUser, worauf die App automatisch nach "/" umleitet.
 */
export const LoginPage = observer(function LoginPage({
  authStore,
  loginModel,
}: LoginPageProps): JSX.Element {
  const handleModeChange = (_event: MouseEvent<HTMLElement>, value: LoginMode | null): void => {
    if (value !== null) {
      loginModel.setMode(value);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void loginModel.submit();
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        px: 2,
      }}
    >
      <Card sx={{ width: '100%', maxWidth: 420 }}>
        <CardContent sx={{ p: 4 }}>
          <Stack spacing={3} component="form" onSubmit={handleSubmit}>
            <Box sx={{ textAlign: 'center' }}>
              <Typography variant="h2" component="h1" color="primary">
                macvibes
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Lokale Vibe-Coding-Plattform
              </Typography>
            </Box>

            <ToggleButtonGroup
              value={loginModel.mode}
              exclusive
              onChange={handleModeChange}
              fullWidth
              size="small"
              data-testselector="login-mode-toggle"
            >
              <ToggleButton value="login">Anmelden</ToggleButton>
              <ToggleButton value="register">Registrieren</ToggleButton>
            </ToggleButtonGroup>

            {authStore.error !== null && (
              <Alert severity="error" data-testselector="login-error">
                {authStore.error}
              </Alert>
            )}
            {authStore.notice !== null && (
              <Alert severity="success" data-testselector="login-notice">
                {authStore.notice}
              </Alert>
            )}
            {loginModel.mode === 'register' && (
              <Alert severity="info" data-testselector="login-register-hint">
                Nach der Registrierung schaltet ein Admin dein Konto frei — danach kannst du dich
                anmelden.
              </Alert>
            )}

            <TextField
              label="Benutzername"
              value={loginModel.username}
              onChange={(e) => loginModel.setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              inputProps={{ 'data-testselector': 'login-username' }}
            />
            <TextField
              label="Passwort"
              type="password"
              value={loginModel.password}
              onChange={(e) => loginModel.setPassword(e.target.value)}
              autoComplete={loginModel.mode === 'login' ? 'current-password' : 'new-password'}
              inputProps={{ 'data-testselector': 'login-password' }}
            />
            <Button
              type="submit"
              variant="contained"
              size="large"
              disabled={!loginModel.canSubmit}
              data-testselector="login-submit"
            >
              {loginModel.mode === 'login' ? 'Anmelden' : 'Registrieren'}
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
});
