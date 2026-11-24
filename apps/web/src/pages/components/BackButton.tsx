import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import IconButton from '@mui/material/IconButton';
import { useNavigate } from 'react-router-dom';

/** Zurück-Pfeil der AppBar: führt zur Projektübersicht. */
export function BackButton({ testselector }: { testselector: string }): JSX.Element {
  const navigate = useNavigate();
  return (
    <IconButton
      edge="start"
      aria-label="Zurück zur Projektübersicht"
      onClick={() => navigate('/')}
      sx={{ mr: 2 }}
      data-testselector={testselector}
    >
      <ArrowBackIcon />
    </IconButton>
  );
}
