import { api } from '../api/client';
import { copyText } from '../api/transport';
import { useAppState } from '../app/state';
import { useToast } from '../ui/toast';

/** The Debug modal's Copy diagnostics (spec §16.2): the backend writes the text (versions, OS,
 * git, the settings with secrets scrubbed and `$HOME` as `~`, R24) from what only the UI knows. */
export async function copyDiagnostics(): Promise<void> {
  const text = await api.diagnostics({ userAgent: navigator.userAgent, settings: useAppState.getState().settings });
  await copyText(text);
  useToast.getState().show('Diagnostics copied');
}

/** Opens the log folder in the file manager, through the backend's file-manager opener. */
export async function openLogsFolder(): Promise<void> {
  await api.openLogsFolder();
}
