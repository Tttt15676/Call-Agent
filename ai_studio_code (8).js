import { readFile } from 'node:fs/promises';

// 1. Verify required environment variables up front
const { VAPI_API_KEY, GEMINI_API_KEY, VAPI_PHONE_NUMBER_ID } = process.env;

if (!VAPI_API_KEY || !GEMINI_API_KEY || !VAPI_PHONE_NUMBER_ID) {
  console.error('Missing required environment variables: VAPI_API_KEY, GEMINI_API_KEY, or VAPI_PHONE_NUMBER_ID');
  process.exit(1);
}

const VAPI_BASE_URL = 'https://api.vapi.ai/call/phone';

// Utility delay function to throttle calls and prevent carrier/concurrency rate limits
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function dispatchOutboundCall(lead) {
  const payload = {
    // Phone number provisioned inside your Vapi dashboard
    phoneNumberId: VAPI_PHONE_NUMBER_ID,

    // Recipient destination details
    customer: {
      number: lead.phone,
      name: lead.managerName,
    },

    assistant: {
      // Direct greeting using dynamic lead metadata
      firstMessage: `Hey ${lead.managerName}, I'm calling quickly regarding the storefront. Do you have a quick minute?`,

      // Gemini 1.5 Flash configuration bypassing default OpenAI routes
      model: {
        provider: 'google',
        model: 'gemini-1.5-flash',
        apiKey: GEMINI_API_KEY,
        messages: [
          {
            role: 'system',
            content: `You are an AI assistant speaking live on the phone with ${lead.managerName}.
- Keep replies ultra-short, casual, and punchy (1-2 sentences maximum per turn).
- Always use natural spoken contractions like "I'm", "don't", "can't", "we've", and "it's".
- STRICT DNC/OPT-OUT RULE: If the caller says "stop calling", "do not call list", "remove me", or expresses any opt-out intent, immediately say "Understood, I'll take you off our list. Have a great day." and end the call. Never dispute or re-pitch.`,
          },
        ],
      },

      // Cartesia neural TTS provider for low-latency conversational audio
      voice: {
        provider: 'cartesia',
        voiceId: '248be419-c632-4f23-adf1-5324ed7dbf10', // Cartesia Conversational American Male
      },

      // Built-in Answering Machine Detection (AMD)
      // When voicemailMessage is omitted, Vapi terminates the call immediately upon detecting a machine
      voicemailDetection: {
        provider: 'google',
      },

      // Automatic hangup triggers if matching phrase is vocalized
      endCallPhrases: [
        'stop calling',
        'do not call list',
        'remove me from your list',
      ],
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
    const fileData = await readFile(new URL('./leads.json', import.meta.url), 'utf-8');
    const leads = JSON.parse(fileData);

    console.log(`Starting outbound run for ${leads.length} leads...`);

    for (const lead of leads) {
      try {
        const result = await dispatchOutboundCall(lead);
        console.log(`[QUEUED] Call triggered for ${lead.managerName} (${lead.phone}) | Call ID: ${result.id}`);
      } catch (err) {
        console.error(`[ERROR] ${err.message}`);
      }

      // Safe pace for a 500-call/mo scale (avoids telephony provider burst thresholds)
      await sleep(1500);
    }

    console.log('Pipeline run finished.');
  } catch (err) {
    console.error(`Pipeline failure: ${err.message}`);
  }
}

runPipeline();