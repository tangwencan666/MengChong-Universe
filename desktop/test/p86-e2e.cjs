'use strict';
// Reuse the existing authenticated Windows/SQLite/Mock lifecycle acceptance.
if(process.argv.slice(2).some(value=>!['--smoke','--minutes=30'].includes(value)))throw Error('Use --smoke or --minutes=30');
process.argv.push('--eight-role','--p86');
require('./p85-e2e.cjs');
