// pos-web/agora-agent.js
// Starts, stops and inspects the Sora agent on Agora Conversational AI Engine v2.
// Used by launch-sora-agent.sh (CLI) and by the "Reconnect Voice Agent" button (/api/voice/reconnect).
//
// Configuration (environment):
//   AGORA_APP_ID                     Agora project App ID
//   AGORA_CUSTOMER_ID/_SECRET        RESTful API credentials (preferred; they don't expire), or
//   AGORA_AUTH_TOKEN                 a token for the "Authorization: agora token=..." scheme
//   AGORA_RTC_TOKEN                  optional RTC token for the agent (overrides properties.token in the payload)
//   PUBLIC_URL                       public https URL of this server (default: auto-detect ngrok on :4040)
//   VOICE_TOOL_TOKEN                 optional shared secret sent by Agora tools as x-voice-token

const fs = require('node:fs');
const path = require('node:path');

const PAYLOAD_PATH = path.join(__dirname, 'agora-join-payload.json');
const STATE_PATH = path.join(__dirname, '.agent-state.json');
const APP_ID = process.env.AGORA_APP_ID || '';
const API_BASE = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${APP_ID}`;

function authHeader() {
  if (process.env.AGORA_CUSTOMER_ID && process.env.AGORA_CUSTOMER_SECRET) {
    const basic = Buffer.from(`${process.env.AGORA_CUSTOMER_ID}:${process.env.AGORA_CUSTOMER_SECRET}`).toString('base64');
    return `Basic ${basic}`;
  }
  if (process.env.AGORA_AUTH_TOKEN) return `agora token=${process.env.AGORA_AUTH_TOKEN}`;
  throw new Error('Agora credentials missing: set AGORA_CUSTOMER_ID + AGORA_CUSTOMER_SECRET, or AGORA_AUTH_TOKEN.');
}

async function agoraRequest(method, apiPath, body) {
  const res = await fetch(`${API_BASE}${apiPath}`, {
    method,
    headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = data.detail || data.message || data.reason || text || res.statusText;
    const hint = res.status === 401 || res.status === 403
      ? ' (Agora rejected the credentials - tokens expire, generate a new one or use customer ID/secret)'
      : '';
    const err = new Error(`Agora ${method} ${apiPath} failed with HTTP ${res.status}: ${detail}${hint}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function detectPublicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  try {
    const res = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(2000) });
    const { tunnels = [] } = await res.json();
    const https = tunnels.find(t => String(t.public_url).startsWith('https://'));
    if (https) return https.public_url.replace(/\/+$/, '');
  } catch {
    // ngrok not running
  }
  throw new Error('No public URL: start ngrok (ngrok http 3000) or set PUBLIC_URL.');
}

function buildPayload(publicUrl) {
  const template = fs.readFileSync(PAYLOAD_PATH, 'utf8');
  const payload = JSON.parse(template.split('__PUBLIC_URL__').join(publicUrl));
  // Agent names must be unique per project while running; reusing one makes Agora reject the join.
  payload.name = `sora-pos-${Date.now().toString(36)}`;
  if (process.env.AGORA_RTC_TOKEN) payload.properties.token = process.env.AGORA_RTC_TOKEN;
  if (process.env.VOICE_TOOL_TOKEN) {
    for (const tool of payload.properties.llm.tools || []) {
      if (tool.server) tool.server.headers = { ...tool.server.headers, 'x-voice-token': process.env.VOICE_TOOL_TOKEN };
    }
  }
  return payload;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function leave() {
  const state = readState();
  if (!state || !state.agentId) return { left: false };
  try {
    await agoraRequest('POST', `/agents/${state.agentId}/leave`);
  } catch (err) {
    // 404 means the agent already stopped (idle timeout); anything else is worth surfacing.
    if (err.status !== 404) throw err;
  }
  fs.rmSync(STATE_PATH, { force: true });
  return { left: true, agentId: state.agentId };
}

async function join(publicUrl) {
  const url = publicUrl || await detectPublicUrl();
  const payload = buildPayload(url);
  // Stop the previous agent first so two Soras never answer in the same channel.
  try {
    await leave();
  } catch (err) {
    console.warn('Could not stop previous agent:', err.message);
  }
  const data = await agoraRequest('POST', '/join', payload);
  const state = {
    agentId: data.agent_id,
    name: payload.name,
    channel: payload.properties.channel,
    publicUrl: url,
    joinedAt: new Date().toISOString()
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  return state;
}

async function status() {
  const state = readState();
  if (!state || !state.agentId) return { running: false, message: 'Sora is not started. Run launch-sora-agent.sh or press Reconnect.' };
  try {
    const data = await agoraRequest('GET', `/agents/${state.agentId}`);
    return { ...state, running: data.status === 'RUNNING', agoraStatus: data.status };
  } catch (err) {
    return { ...state, running: false, agoraStatus: 'UNKNOWN', message: err.message };
  }
}

module.exports = { join, leave, status, buildPayload };

if (require.main === module) {
  const [command = 'join', arg] = process.argv.slice(2);
  const actions = { join: () => join(arg), leave, status };
  if (!actions[command]) {
    console.error('Usage: node agora-agent.js join [public-url] | leave | status');
    process.exit(2);
  }
  actions[command]()
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}
