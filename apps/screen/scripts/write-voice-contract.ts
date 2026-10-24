import { writeFileSync } from 'node:fs';
import { deskVoiceContract } from '../server/desk/voice-contract.js';

// Run from any directory: npx tsx apps/screen/scripts/write-voice-contract.ts
writeFileSync(new URL('../../tango-voice/test/fixtures/desk-contract.json', import.meta.url), `${JSON.stringify(deskVoiceContract(), null, 2)}\n`);
