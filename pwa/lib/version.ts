/** Single source of the app version: package.json (kept in sync with git
 *  tags at release time). Imported by the theme page / settings. */
import pkg from '../package.json';

export const VERSION = pkg.version;
