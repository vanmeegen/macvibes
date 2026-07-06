import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AuthStore } from '../models/AuthStore';

export interface AdminPageProps {
  authStore: AuthStore;
}

/**
 * Admin-Nutzerverwaltung: neue Selbst-Registrierungen freischalten oder
 * ablehnen. Nur für Admins erreichbar (die Route in App.tsx leitet sonst um;
 * die `users`-Query ist serverseitig admin-only abgesichert).
 */
export const AdminPage = observer(function AdminPage({ authStore }: AdminPageProps): JSX.Element {
  const navigate = useNavigate();

  useEffect(() => {
    void authStore.loadUsers();
  }, [authStore]);

  const pendingCount = authStore.pendingUsers.length;

  return (
    <Box sx={{ minHeight: '100vh', pb: 8 }}>
      <AppBar position="sticky">
        <Toolbar>
          <IconButton
            edge="start"
            aria-label="Zurück zur Projektübersicht"
            onClick={() => navigate('/')}
            sx={{ mr: 2 }}
            data-testselector="admin-back-button"
          >
            <ArrowBackIcon />
          </IconButton>
          <Typography variant="h5" component="h1" sx={{ flexGrow: 1 }}>
            Nutzerverwaltung
          </Typography>
          {pendingCount > 0 && (
            <Chip
              color="warning"
              label={`${pendingCount} warten auf Freischaltung`}
              data-testselector="admin-pending-count"
            />
          )}
        </Toolbar>
      </AppBar>

      <Box sx={{ maxWidth: 900, mx: 'auto', px: 3, pt: 3 }}>
        <Paper variant="outlined">
          <Table data-testselector="admin-user-table">
            <TableHead>
              <TableRow>
                <TableCell>Benutzer</TableCell>
                <TableCell>Rolle</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Aktionen</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {authStore.users.map((user) => {
                const isAdmin = user.role === 'admin';
                return (
                  <TableRow
                    key={user.id}
                    data-testselector="admin-user-row"
                    data-username={user.username}
                    data-approved={user.approved ? 'true' : 'false'}
                  >
                    <TableCell>{user.username}</TableCell>
                    <TableCell>
                      {isAdmin ? (
                        <Chip size="small" color="primary" label="Admin" />
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          User
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      {user.approved ? (
                        <Chip
                          size="small"
                          color="success"
                          variant="outlined"
                          label="Freigeschaltet"
                        />
                      ) : (
                        <Chip size="small" color="warning" label="Wartet" />
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={1} justifyContent="flex-end">
                        {!user.approved && (
                          <Button
                            size="small"
                            variant="contained"
                            onClick={() => void authStore.approveUser(user.id)}
                            data-testselector="admin-approve"
                          >
                            Zulassen
                          </Button>
                        )}
                        {!isAdmin && (
                          <Button
                            size="small"
                            color="error"
                            variant="outlined"
                            onClick={() => void authStore.rejectUser(user.id)}
                            data-testselector="admin-reject"
                          >
                            {user.approved ? 'Entfernen' : 'Ablehnen'}
                          </Button>
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
              {authStore.users.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4}>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ textAlign: 'center', py: 2 }}
                    >
                      Noch keine Nutzer.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Paper>
      </Box>
    </Box>
  );
});
