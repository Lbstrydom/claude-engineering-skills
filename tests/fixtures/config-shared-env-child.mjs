
import './../../scripts/lib/config.mjs';
const keys = ['AUDIT_DB_URL', 'OPENAI_API_KEY', 'GEMINI_API_KEY', '_AUDIT_LOOP_SHARED_LOADED'];
const out = {};
for (const k of keys) out[k] = process.env[k] ?? null;
process.stdout.write(JSON.stringify(out));
