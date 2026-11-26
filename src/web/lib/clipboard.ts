/**
 * Puts the text of a read-only field on the clipboard. When the browser refuses (no permission, an insecure page), the text
 * is selected instead, so that the user can copy it by hand; the result says which of the two happened.
 */
export async function copyField(field: HTMLInputElement | HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(field.value);
    return true;
  } catch {
    field.focus();
    field.select();
    return false;
  }
}
