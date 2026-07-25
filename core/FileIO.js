// Generic browser file-download utility - no server round-trip, just a throwaway object URL +
// a synthetic click, cleaned up immediately after. Used anywhere a dev-tooling panel needs to
// hand the user a file (CSV exports today; not tied to spin logs or any other specific format).

/**
 * Triggers a browser download of `text` as a file named `filename`.
 * @param {string} filename
 * @param {string} text
 * @param {string} [mimeType='text/csv']
 */
export function downloadTextFile(filename, text, mimeType = 'text/csv') {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
