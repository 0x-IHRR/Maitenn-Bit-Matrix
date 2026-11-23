import { isAbsolute as posixAbsolute } from 'node:path/posix';
import { isAbsolute as winAbsolute } from 'node:path/win32';

// Accept macOS/Linux paths and Windows drive or UNC paths on any host.
// The server runs on the user's machine; rejecting "C:\\..." was the Windows bug.
export function isAbsolutePath(value) {
  const s = String(value ?? '');
  return s.length > 0 && (posixAbsolute(s) || winAbsolute(s));
}
