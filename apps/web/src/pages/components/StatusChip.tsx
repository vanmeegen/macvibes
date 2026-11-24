import Chip from '@mui/material/Chip';
import type { SxProps, Theme } from '@mui/material/styles';
import type { SandboxStatus } from '../../api/types';
import { projectStatusChip } from '../../models/projectPresentation';

/**
 * Status-Chip eines Projekts (Projektkarte und Chat-Kopfzeile): „arbeitet" bei
 * laufendem Turn, sonst der Sandbox-Status.
 */
export function StatusChip({
  sandboxStatus,
  turnActive,
  testselector,
  sx,
}: {
  sandboxStatus: SandboxStatus;
  turnActive: boolean;
  testselector: string;
  sx?: SxProps<Theme>;
}): JSX.Element {
  const chip = projectStatusChip(sandboxStatus, turnActive);
  return (
    <Chip
      size="small"
      label={chip.label}
      color={chip.color}
      variant="outlined"
      sx={sx ?? {}}
      data-testselector={testselector}
      data-status={sandboxStatus}
      data-turn-active={turnActive ? 'true' : 'false'}
    />
  );
}
