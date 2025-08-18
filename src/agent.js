// Minimal v1 agent: enroll -> wait for approval -> heartbeat loop
require('dotenv').config();
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const axios = require('axios');
const open = require('open');


const CONTROLLER = process.env.CONTROLLER_URL || 'http://localhost:8080';
const STATE_DIR = process.env.AGENT_STATE_DIR || path.join(os.homedir(), '.sec-viewer');
const FP_FILE = path.join(STATE_DIR, 'fingerprint.json');
const CLIENT_FILE = path.join(STATE_DIR, 'client.json');
const HEARTBEAT_MS = Number(process.env.HEARTBEAT || 30000);
const SCREEN_W   = Number(process.env.AGENT_SCREEN_W || 1920);
const SCREEN_H   = Number(process.env.AGENT_SCREEN_H || 1080);
const SCREEN_DPR = Number(process.env.AGENT_SCREEN_DPR || 1);
const SCREEN_ROT = Number(process.env.AGENT_SCREEN_ROT || 0); // 0|90|180|270

(async function main() {
  await fs.ensureDir(STATE_DIR);
  console.log(`[agent] controller: ${CONTROLLER}`);
  console.log(`[agent] state dir : ${STATE_DIR}`);

  // If already approved before, resume heartbeat using stored token
  if (await fs.pathExists(CLIENT_FILE)) {
    const { clientId, token } = await fs.readJson(CLIENT_FILE);
    console.log(`[agent] found existing client (${clientId}), resuming heartbeats...`);
    return heartbeatLoop(clientId, token);
  }

  const fingerprint = await getOrCreateFingerprint();
  const hostname = os.hostname();
  const ip = firstIPv4() || '0.0.0.0';

  console.log('[agent] enrolling…');
  const { requestId } = await postEnrollRequest({ hostname, ip, fingerprint });
  console.log(`[agent] requestId=${requestId}. Waiting for approval...`);

  const { clientId, bootstrapToken } = await pollApproval(requestId);
  console.log(`[agent] approved as ${clientId}. Starting heartbeats.`);
  await fs.writeJson(CLIENT_FILE, { clientId, token: bootstrapToken }, { spaces: 2 });
  
  // DEV ONLY: open viewer page locally
  try {
    const base = process.env.VIEWER_BASE || 'http://localhost:8080';
    await open(`${base}/viewer?id=${clientId}`);
  } catch (e) {
    console.warn('[agent] could not open viewer:', e.message);
  }
  
  return heartbeatLoop(clientId, bootstrapToken);
})().catch(err => {
  console.error('[agent] fatal error:', err?.message || err);
  process.exit(1);
});

async function getOrCreateFingerprint() {
  if (await fs.pathExists(FP_FILE)) {
    const { fingerprint } = await fs.readJson(FP_FILE);
    if (fingerprint) return fingerprint;
  }
  // Simple lab fingerprint: hostname + random suffix
  const fp = `fp_${os.hostname()}_${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeJson(FP_FILE, { fingerprint: fp }, { spaces: 2 });
  return fp;
}

function firstIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n && !n.internal && n.family === 'IPv4') return n.address;
    }
  }
  return null;
}

async function postEnrollRequest({ hostname, ip, fingerprint }) {
  const { data } = await axios.post(`${CONTROLLER}/enroll/requests`, { hostname, ip, fingerprint }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
  });
  return data; // { requestId, status }
}

async function pollApproval(requestId) {
  // Poll every 2s until approved or rejected
  while (true) {
    const { data } = await axios.get(`${CONTROLLER}/enroll/status/${requestId}`, { timeout: 10000 });
    if (data.status === 'approved') return data; // { status, clientId, bootstrapToken }
    if (data.status === 'rejected') throw new Error('Enrollment rejected by server');
    await sleep(2000);
  }
}

async function heartbeatLoop(clientId, token) {
  while (true) {
    try {
      await axios.post(`${CONTROLLER}/clients/${clientId}/heartbeat`, {
        version: 'dev-1',              // keep whatever you already send
        layoutHash: 'demo',            // keep whatever you already send
        screen: {                      // NEW
          width: SCREEN_W,
          height: SCREEN_H,
          dpr: SCREEN_DPR,
          rotation: SCREEN_ROT
        }
      }, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      });
      console.log(`[agent] heartbeat ok @ ${new Date().toISOString()}`);
    } catch (e) {
      const code = e?.response?.status || e.code || e.message;
      console.error('[agent] heartbeat failed:', code);
      // If server lost state (404), clear local state and re-enroll
      if (e?.response?.status === 404) {
        try { await fs.remove(CLIENT_FILE); } catch {}
        return relaunch(); // back to enroll flow
      }
    }
    await sleep(HEARTBEAT_MS);
  }
}

async function relaunch() {
  const fingerprint = await getOrCreateFingerprint();
  const hostname = os.hostname();
  const ip = firstIPv4() || '0.0.0.0';
  console.log('[agent] re-enrolling…');
  const { requestId } = await postEnrollRequest({ hostname, ip, fingerprint });
  console.log(`[agent] requestId=${requestId}. Waiting for approval...`);
  const { clientId, bootstrapToken } = await pollApproval(requestId);
  await fs.writeJson(CLIENT_FILE, { clientId, token: bootstrapToken }, { spaces: 2 });
  return heartbeatLoop(clientId, bootstrapToken);
}


function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
