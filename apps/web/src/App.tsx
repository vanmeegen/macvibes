import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { observer } from 'mobx-react-lite';
import { Navigate, Route, Routes } from 'react-router-dom';
import {
  authStore,
  chatStore,
  createProjectModel,
  loginModel,
  previewModel,
  projectsStore,
} from './models/stores';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './pages/LoginPage';
import { ProjectsPage } from './pages/ProjectsPage';

export const App = observer(function App(): JSX.Element {
  if (!authStore.initialized) {
    return (
      <Box
        sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}
      >
        <CircularProgress data-testselector="app-loading" />
      </Box>
    );
  }

  const loggedIn = authStore.currentUser !== null;

  return (
    <Routes>
      <Route
        path="/login"
        element={
          loggedIn ? (
            <Navigate to="/" replace />
          ) : (
            <LoginPage authStore={authStore} loginModel={loginModel} />
          )
        }
      />
      <Route
        path="/"
        element={
          loggedIn ? (
            <ProjectsPage
              authStore={authStore}
              projectsStore={projectsStore}
              createProjectModel={createProjectModel}
            />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/projects/:id"
        element={
          loggedIn ? (
            <ChatPage
              projectsStore={projectsStore}
              chatStore={chatStore}
              previewModel={previewModel}
            />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
});
