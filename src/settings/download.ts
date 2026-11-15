import { getAndroidAlarmClient } from '../alarm/androidAlarmClient';

/** Hand a UTF-8 file to the local system picker or browser, never a server. */
export async function downloadText(
  filename: string,
  text: string,
  type = 'text/plain;charset=utf-8',
): Promise<void> {
  const client = getAndroidAlarmClient();
  const state = client.getSnapshot();
  if (state.status === 'ready') {
    const mimeType = type.split(';')[0];
    if (mimeType !== 'application/json' && mimeType !== 'text/plain' && mimeType !== 'text/csv') {
      throw new Error('Dieses Dateiformat wird in der Android-App nicht unterstützt.');
    }
    const result = await client.saveTextDocument({ filename, text, mimeType });
    if (result === 'cancelled') throw new Error('Die Dateisicherung wurde abgebrochen.');
    return;
  }
  if (state.status === 'connecting' || state.status === 'error') {
    throw new Error('Die Android-Dateiverbindung ist noch nicht bereit. Bitte versuche es erneut.');
  }
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;

  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Revoking immediately can interrupt the download in some browsers.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
