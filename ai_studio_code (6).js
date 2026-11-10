import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

const PORT = process.env.PORT || 3000;

async function addToDNC(phoneNumber) {
  try {
    const dncPath = new URL('./dnc.json', import.meta.url);
    const dncData = JSON.parse(await readFile(dncPath, 'utf-8'));
    if (!dncData.includes(phoneNumber)) {
      dncData.push(phoneNumber);
      await writeFile(dncPath, JSON.stringify(dncData, null, 2));
      console.log(`[DNC UPDATED] Added ${phoneNumber} to suppression list.`);
    }
  } catch (err) {
    console.error(`Failed to update DNC list: ${err.message}`);
  }
}

const server = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end();
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const { type } = payload.message || {};

      // 1. Handle in-call function calls (Tools) triggered by Gemini
      if (type === 'tool-calls') {
        const toolCalls = payload.message.toolCalls;
        const results = [];

        for (const toolCall of toolCalls) {
          const { id, function: fn } = toolCall;
          const args = JSON.parse(fn.arguments || '{}');

          if (fn.name === 'bookMeeting') {
            console.log(`[TOOL CALL] Booking meeting at ${args.preferredTime}. Notes: ${args.notes}`);
            results.push({
              toolCallId: id,
              result: `Meeting successfully reserved for ${args.preferredTime}.`
            });
          }

          if (fn.name === 'recordDNC') {
            await addToDNC(args.phone);
            results.push({
              toolCallId: id,
              result: 'The number was successfully added to the internal DNC registry.'
            });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ results }));
      }

      // 2. Handle post-call analysis and audit logging
      if (type === 'end-of-call-report') {
        const { call, transcript, summary, endedReason } = payload.message;
        console.log(`\n================ CALL REPORT ================`);
        console.log(`Customer: ${call.customer?.number}`);
        console.log(`Ended Reason: ${endedReason}`);
        console.log(`Summary: ${summary}`);
        console.log(`Cost: $${payload.message.cost?.toFixed(4) || 0}`);
        console.log(`=============================================\n`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } catch (err) {
      console.error('Webhook processing error:', err);
      res.writeHead(400);
      res.end();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Vapi webhook server active on port ${PORT}`);
});