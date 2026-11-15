/** Hand a UTF-8 file to the browser without sending its contents anywhere. */
export function downloadText(
  filename: string,
  text: string,
  type = 'text/plain;charset=utf-8',
): void {
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
