import { readFile, writeFile } from 'node:fs/promises';

const { VAPI_API_KEY, GEMINI_API_KEY, VAPI_PHONE_NUMBER_ID, WEBHOOK_URL, TRANSFER_PHONE_NUMBER } = process.env;

if (!VAPI_API_KEY || !GEMINI_API_KEY || !VAPI_PHONE_NUMBER_ID) {
  console.error('Missing required environment variables.');
  process.exit(1);
}

const VAPI_BASE_URL = 'https://api.vapi.ai/call/phone';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Checks if call is within legal TCPA window (8:00 AM to 8:00 PM)
function isWithinCallingHours(timeZone = 'America/New_York') {
  const hour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false
  }).format(new Date()), 10);

  return hour >= 8 && hour < 20;
}

async function dispatchOutboundCall(lead, dncList) {
  // 1. Suppression check
  if (dncList.has(lead.phone)) {
    console.log(`[SKIPPED] ${lead.phone} is on the DNC list.`);
    return null;
  }

  // 2. Calling hour guard
  if (!isWithinCallingHours(lead.timezone || 'America/New_York')) {
    console.log(`[SKIPPED] ${lead.phone} is outside legal calling hours (8am - 8pm).`);
    return null;
  }

  const payload = {
    phoneNumberId: VAPI_PHONE_NUMBER_ID,
    customer: {
      number: lead.phone,
      name: lead.managerName,
    },
    // Routes call lifecycle events and function calls to your webhook
    serverUrl: WEBHOOK_URL || undefined,

    assistant: {
      firstMessage: `Hi ${lead.managerName}, this is Alex calling on behalf of StoreOps. Did I catch you at an okay time?`,

      // Fine-tune latency and human-like flow
      silenceTimeoutSeconds: 25,
      maxDurationSeconds: 600,
      numWordsToInterruptAssistant: 2, // Allows natural user interruption (barge-in)
      responseDelaySeconds: 0.4,       // Eliminates awkward robotic pauses

      model: {
        provider: 'google',
        model: 'gemini-1.5-flash',
        apiKey: GEMINI_API_KEY,
        messages: [
          {
            role: 'system',
            content: `You are Alex, an outbound representative for StoreOps speaking with ${lead.managerName}.
- Keep all responses concise (1-2 sentences max).
- Always use conversational contractions ("I'm", "we'd", "don't").
- GOAL: Qualify interest in our automated storefront audit. If interested, use the 'bookMeeting' tool.
- ESCALATION: If they demand to speak to a senior specialist right now, use the 'transferCall' tool.
- TCPA MANDATE: If the user says "stop calling", "remove me", "unsubscribe", or expresses opt-out intent, politely confirm removal, call the 'recordDNC' tool, and say goodbye.`,
          },
        ],
        // Gemini function definitions
        tools: [
          {
            type: 'function',
            function: {
              name: 'bookMeeting',
              description: 'Schedules a calendar consultation with the lead.',
              parameters: {
                type: 'object',
                properties: {
                  preferredTime: { type: 'string', description: 'Requested day and time, e.g., tomorrow at 3pm' },
                  notes: { type: 'string', description: 'Key points mentioned by the lead' }
                },
                required: ['preferredTime']
              }
            }
          },
          {
            type: 'function',
            function: {
              name: 'recordDNC',
              description: 'Permanently removes the lead from all future contact lists.',
              parameters: {
                type: 'object',
                properties: {
                  phone: { type: 'string', description: 'The phone number to opt out' }
                },
                required: ['phone']
              }
            }
          }
        ]
      },

      voice: {
        provider: 'cartesia',
        voiceId: '248be419-c632-4f23-adf1-5324ed7dbf10',
      },

      // Transfer configuration triggered if Gemini returns a transfer instruction
      forwardingPhoneNumber: TRANSFER_PHONE_NUMBER || undefined,

      voicemailDetection: {
        provider: 'google',
      },

      endCallPhrases: [
        'stop calling',
        'do not call list',
        'remove me from your list'
      ]
    },
  };

  const response = await fetch(VAPI_BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Call to ${lead.phone} failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

async function runPipeline() {
  try {
    const leadsData = JSON.parse(await readFile(new URL('./leads.json', import.meta.url), 'utf-8'));
    const dncRaw = JSON.parse(await readFile(new URL('./dnc.json', import.meta.url), 'utf-8'));
    const dncList = new Set(dncRaw);

    console.log(`Processing ${leadsData.length} leads with ${dncList.size} suppressed numbers...`);

    for (const lead of leadsData) {
      try {
        const res = await dispatchOutboundCall(lead, dncList);
        if (res) console.log(`[DISPATCHED] Lead: ${lead.managerName} | Call ID: ${res.id}`);
      } catch (err) {
        console.error(`[CALL ERROR] ${err.message}`);
      }
      await sleep(2000); // 2-second rate limit between dispatches
    }
  } catch (err) {
    console.error(`Pipeline failure: ${err.message}`);
  }
}

runPipeline();