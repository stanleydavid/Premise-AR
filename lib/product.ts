/** Product identifiers (EarthOps naming): stable service name and error-code prefix. */
export const SERVICE = 'semak-premis';
export const PRODUCT_CODE = 'SEMAK';
export const SESSION_COOKIE = 'semak_session';
/** Officers work a field shift; the session outlives it so a pending sync does not hit a login wall mid-shift. */
export const SESSION_HOURS = 10;
