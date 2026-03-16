// Channel self-registration barrel file.
// Each import triggers the channel module's registerChannel() call.

// discord

// gmail

// slack

// cli
import './cli.js';

// cli-buffer (always active — HTTP API fallback for cli:* JIDs)
import './cli-buffer.js';

// telegram
import './telegram.js';

// whatsapp
