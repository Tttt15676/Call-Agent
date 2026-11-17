import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

const PORT = process.env.PORT || 3000;
const VAPI_SECRET = process.env.VAPI_SECRET || '';
const MAX_BODY_BYTES = 1_048_576; // 1 MB payload limit to prevent memory abuse

// Simple write queue to prevent simultaneous calls from corrupting dnc.json
let dncWriteQueue = Promise.resolve();

function addToDNC(phoneNumber) {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return Promise.resolve(false);
  }

  const normalizedPhone = phoneNumber.trim();

  dncWriteQueue = dncWriteQueue.then(async () => {
    try {
      const dncPath = new URL('./dnc.json', import.meta.url);
      let dncData = [];

      try {
        const raw = await readFile(dncPath, 'utf-8');
        dncData = JSON.parse(raw);
        if (!Array.isArray(dncData)) dncData = [];
      } catch (readErr) {
        if (readErr.code !== 'ENOENT') throw readErr;
      }

      if (!dncData.includes(normalizedPhone)) {
        dncData.push(normalizedPhone);
        await writeFile(dncPath, JSON.stringify(dncData, null, 2));
        console.log(`[DNC UPDATED] Added ${normalizedPhone} to suppression list.`);
      }
      return true;
    } catch (err) {
      console.error(`[DNC ERROR] Failed to update DNC list: ${err.message}`);
      return false;
    }
  });

  return dncWriteQueue;
}

const server = createServer(async (req, res) => {
  // 1. Health check endpoint for 24/7 hosting platforms (Render, Railway, Fly.io)
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
  }

  // 2. Reject non-POST requests
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  // 3. Verify Vapi secret token if configured in .env
  if (VAPI_SECRET) {
    const incomingSecret = req.headers['x-vapi-secret'];
    if (incomingSecret !== VAPI_SECRET) {
      console.warn('[SECURITY] Blocked unauthorized webhook request.');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
  }

  // 4. Read incoming JSON payload with a size cap
  let body = '';
  let byteLength = 0;

  for await (const chunk of req) {
    byteLength += chunk.length;
    if (byteLength > MAX_BODY_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Payload too large' }));
    }
    body += chunk;
  }

  try {
    const payload = JSON.parse(body || '{}');
    const message = payload.message || {};
    const { type } = message;

    // 5. Handle live in-call function calls (Tools)
    if (type === 'tool-calls') {
      const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
      const results = [];

      for (const toolCall of toolCalls) {
        const { id, function: fn } = toolCall;
        if (!fn || !fn.name) continue;

        // Safely handle arguments whether Vapi sends a JSON string or an object
        let args = {};
        try {
          args = typeof fn.arguments === 'string'
            ? JSON.parse(fn.arguments || '{}')
            : (fn.arguments || {});
        } catch {
          console.warn(`[WARN] Could not parse arguments for ${fn.name}`);
        }

        if (fn.name === 'bookMeeting') {
          const time = args.preferredTime || 'an unspecified time';
          const notes = args.notes || 'No notes provided';
          console.log(`[MEETING BOOKED] Time: ${time} | Notes: ${notes}`);

          // TODO: Connect your Cal.com or Google Calendar API call here

          results.push({
            toolCallId: id,
            result: `Meeting successfully reserved for ${time}.`
          });
        } else if (fn.name === 'recordDNC') {
          const phone = args.phone || message.call?.customer?.number;
          await addToDNC(phone);

          results.push({
            toolCallId: id,
            result: 'The number was successfully added to the internal DNC registry.'
          });
        } else {
          results.push({
            toolCallId: id,
            result: `Unknown tool requested: ${fn.name}`
          });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ results }));
    }

    // 6. Handle post-call summary and cost reporting
    if (type === 'end-of-call-report') {
      const { call, summary, endedReason, cost } = message;
      console.log('\n================ CALL REPORT ================');
      console.log(`Customer: ${call?.customer?.number || 'Unknown'}`);
      console.log(`Ended Reason: ${endedReason || 'Unknown'}`);
      console.log(`Summary: ${summary || 'No summary generated'}`);
      console.log(`Cost: $${typeof cost === 'number' ? cost.toFixed(4) : '0.0000'}`);
      console.log('=============================================\n');
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
  }
});

server.listen(PORT, () => {
  console.log(`Vapi webhook server active on port ${PORT}`);
});
            
