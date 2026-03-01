// api/proxy.js — Vercel Edge Function
// Soporta Anthropic y OpenRouter — usa la key que esté configurada

export const config = { runtime: 'edge' };

const RATE_LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000;
const rateLimitStore = new Map();

function getRateLimit(id) {
  const now = Date.now();
  const entry = rateLimitStore.get(id);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    rateLimitStore.set(id, { count: 1, windowStart: now });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  if (entry.count >= RATE_LIMIT) return { allowed: false, remaining: 0 };
  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT - entry.count };
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const allowedOrigins = [
    'https://contaleacarlitos.vercel.app',
    'https://heycarlitos.app',
    'http://localhost:3000',
  ];
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  const corsHeaders = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-user-id',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const userId = req.headers.get('x-user-id') || req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  const { allowed, remaining } = getRateLimit(userId);
  if (!allowed) {
    return new Response(
      JSON.stringify({ error: 'Demasiadas requests. Esperá un rato.' }),
      { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try { body = await req.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'Body inválido' }), { status: 400, headers: corsHeaders });
  }

  if (!body.max_tokens || body.max_tokens > 1500) body.max_tokens = 1000;

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (!anthropicKey && !openrouterKey) {
    return new Response(
      JSON.stringify({ error: 'API key no configurada' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  let apiUrl, headers, requestBody;

  if (anthropicKey) {
    const allowedModels = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
    if (!allowedModels.includes(body.model)) body.model = 'claude-sonnet-4-6';
    apiUrl = 'https://api.anthropic.com/v1/messages';
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    };
    requestBody = body;
  } else {
    apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
    headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openrouterKey}`,
      'HTTP-Referer': 'https://contaleacarlitos.vercel.app',
      'X-Title': 'Contale a Carlitos',
    };
    // Convertir mensajes Anthropic → OpenAI
    const msgs = (body.messages || []).map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
        : m.content
    }));
    requestBody = {
      model: 'anthropic/claude-sonnet-4-5',
      max_tokens: body.max_tokens,
      messages: msgs,
    };
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();

    // Normalizar respuesta OpenRouter → formato Anthropic
    let finalData = data;
    if (!anthropicKey && data.choices?.[0]?.message?.content) {
      finalData = {
        content: [{ type: 'text', text: data.choices[0].message.content }]
      };
    }

    return new Response(JSON.stringify(finalData), {
      status: response.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-RateLimit-Remaining': String(remaining) },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Error conectando con la API' }),
      { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}
