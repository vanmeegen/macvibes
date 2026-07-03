import { createTheme, responsiveFontSizes } from '@mui/material/styles';

const BODY_FONT_FAMILY =
  '"Open Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif';

// Freundliches Dev-Tool-Dunkelthema: tiefes Blaugrau mit Violett/Türkis-Akzenten.
const BG_DEFAULT = '#0F172A';
const BG_PAPER = '#1E293B';
const PRIMARY = '#A78BFA';
const PRIMARY_DARK = '#7C3AED';
const SECONDARY = '#2DD4BF';
const TEXT_PRIMARY = '#E2E8F0';
const TEXT_SECONDARY = '#94A3B8';
const DIVIDER = 'rgba(148, 163, 184, 0.16)';

const baseTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: PRIMARY,
      dark: PRIMARY_DARK,
      contrastText: '#0F172A',
    },
    secondary: {
      main: SECONDARY,
      contrastText: '#0F172A',
    },
    background: {
      default: BG_DEFAULT,
      paper: BG_PAPER,
    },
    text: {
      primary: TEXT_PRIMARY,
      secondary: TEXT_SECONDARY,
    },
    divider: DIVIDER,
    error: { main: '#F87171' },
    warning: { main: '#FBBF24' },
    success: { main: '#34D399' },
    info: { main: '#38BDF8' },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: BODY_FONT_FAMILY,
    h1: { fontWeight: 700, fontSize: '2.25rem' },
    h2: { fontWeight: 700, fontSize: '1.75rem' },
    h3: { fontWeight: 700, fontSize: '1.5rem' },
    h4: { fontWeight: 600, fontSize: '1.25rem' },
    h5: { fontWeight: 700, fontSize: '1.1rem' },
    h6: { fontWeight: 700, fontSize: '1rem' },
    button: { textTransform: 'none', fontWeight: 600 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { backgroundColor: BG_DEFAULT },
      },
    },
    MuiAppBar: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          backgroundColor: BG_PAPER,
          backgroundImage: 'none',
          borderBottom: `1px solid ${DIVIDER}`,
        },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: 999, paddingInline: 18 },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: 'none' },
      },
    },
    MuiCard: {
      defaultProps: { elevation: 0, variant: 'outlined' },
      styleOverrides: {
        root: {
          borderColor: DIVIDER,
          transition: 'border-color 120ms ease, transform 120ms ease',
          '&:hover': { borderColor: PRIMARY },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 999 },
      },
    },
    MuiTextField: {
      defaultProps: { fullWidth: true },
    },
    MuiDialog: {
      styleOverrides: {
        paper: { borderRadius: 14, border: `1px solid ${DIVIDER}` },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 600,
          '&.Mui-selected': { color: PRIMARY },
        },
      },
    },
  },
});

export const theme = responsiveFontSizes(baseTheme);
