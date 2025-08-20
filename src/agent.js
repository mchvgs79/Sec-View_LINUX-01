// Minimal v1 agent: enroll -> wait for approval -> heartbeat loop
require('dotenv').config();
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const axios = require('axios');
const dns = require('dns').promises;
// 'open' is an ES module; load dynamically so CommonJS can run this file.
let _openModule = null;
async function openUrl(url) {
  try {
    if (!_openModule) {
      const m = await import('open');
      _openModule = m && (m.default || m);
    }
    return _openModule(url);
  } catch (e) {
    console.warn('[agent] open() not available:', e && e.message);
  }
}


// Controller configuration and discovery
const DEFAULT_CONTROLLERS = ['http://localhost:8080'];
let activeController = null; // chosen controller URL for heartbeats

function normalizeUrl(u) {
  if (!u) return null;
  u = u.trim();
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  // strip trailing slash
  return u.replace(/\/$/, '');
}

function getControllersFromEnv() {
  const list = [];
  if (process.env.CONTROLLER_URLS) {
    for (const part of process.env.CONTROLLER_URLS.split(',')) {
      const n = normalizeUrl(part);
      if (n) list.push(n);
    }
  }
  if (process.env.CONTROLLER_URL && list.length === 0) {
    list.push(normalizeUrl(process.env.CONTROLLER_URL));
  }
  return list.length ? list : [...DEFAULT_CONTROLLERS];
}

async function discoverViaDnsSrv(srvName) {
  try {
    const records = await dns.resolveSrv(srvName);
    return records.map(r => normalizeUrl(`${r.name}:${r.port}`));
  } catch (e) {
    return [];
  }
}

async function discoverViaDhcpOption(option, leaseFile) {
  // option: string or numeric option name/id to look for
  // leaseFile: optional explicit lease file path to parse
  const candidates = [];
  if (leaseFile) candidates.push(leaseFile);
  // common DHCP lease locations
  candidates.push('/var/lib/dhcp/dhclient.leases');
  candidates.push('/run/systemd/netif/leases');
  candidates.push('/var/lib/NetworkManager');

  const found = new Set();
  for (const p of candidates) {
    try {
      const stat = await fs.stat(p);
      if (stat.isDirectory()) {
        const names = await fs.readdir(p);
        for (const name of names) {
          const fp = path.join(p, name);
          try { const txt = await fs.readFile(fp, 'utf8'); extractFromText(txt, option, found); } catch (e) { /* ignore */ }
        }
      } else if (stat.isFile()) {
        try { const txt = await fs.readFile(p, 'utf8'); extractFromText(txt, option, found); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      // ignore missing
    }
  }

  return Array.from(found).map(u => normalizeUrl(u)).filter(Boolean);

  function extractFromText(txt, opt, outSet) {
    if (!txt || !opt) return;
    const name = String(opt).trim();
    // 1) look for dhclient-style: option <name> "value"; or option <name> value;
    const reOptQuoted = new RegExp(`option\\s+${escapeRegExp(name)}\\s+"([^"]+)"`, 'ig');
    let m;
    while ((m = reOptQuoted.exec(txt))) outSet.add(m[1].trim());

    const reOptBare = new RegExp(`option\\s+${escapeRegExp(name)}\\s+([^;\n]+)`, 'ig');
    while ((m = reOptBare.exec(txt))) outSet.add(m[1].trim().replace(/;$/, '').trim());

    // 2) systemd-networkd style: OPTION_<num>=value or OPTION_<name>=value
    const reSysd = new RegExp(`OPTION_(?:${escapeRegExp(name)}|${escapeRegExp(String(name).replace(/[^0-9]/g, ''))})=([^
]+)`, 'ig');
    while ((m = reSysd.exec(txt))) outSet.add(m[1].trim().replace(/^"|"$/g, ''));

    // 3) common plain lines containing the name and a URL/host:port
    const reUrlish = /([a-zA-Z0-9\-_.]+:\d{1,5}|https?:\/\/[a-zA-Z0-9\-_.:]+|[a-zA-Z0-9\-_.]+\.[a-zA-Z]{2,6}:\d{1,5})/g;
    while ((m = reUrlish.exec(txt))) outSet.add(m[1]);
  }

  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
}
const STATE_DIR = process.env.AGENT_STATE_DIR || path.join(os.homedir(), '.sec-viewer');
const FP_FILE = path.join(STATE_DIR, 'fingerprint.json');
const CLIENT_FILE = path.join(STATE_DIR, 'client.json');
let HEARTBEAT_MS = Number(process.env.HEARTBEAT || 30000);
const SCREEN_W   = Number(process.env.AGENT_SCREEN_W || 1920);
const SCREEN_H   = Number(process.env.AGENT_SCREEN_H || 1080);
const SCREEN_DPR = Number(process.env.AGENT_SCREEN_DPR || 1);
const SCREEN_ROT = Number(process.env.AGENT_SCREEN_ROT || 0); // 0|90|180|270

(async function main() {
  await fs.ensureDir(STATE_DIR);
  const envControllers = getControllersFromEnv();
  console.log(`[agent] controllers (env): ${envControllers.join(', ')}`);
  // attempt DNS-SRV discovery if configured
  if (process.env.CONTROLLER_SRV) {
    const srvDiscovered = await discoverViaDnsSrv(process.env.CONTROLLER_SRV);
    if (srvDiscovered.length) {
      console.log('[agent] discovered controllers via DNS-SRV:', srvDiscovered.join(', '));
      // prepend discovered ones so they are tried first
      envControllers.unshift(...srvDiscovered.filter(u => !envControllers.includes(u)));
    }
  }
  console.log(`[agent] state dir : ${STATE_DIR}`);

  // If already approved before, resume heartbeat using stored token
  if (await fs.pathExists(CLIENT_FILE)) {
    const { clientId, token } = await fs.readJson(CLIENT_FILE);
    console.log(`[agent] found existing client (${clientId}), resuming heartbeats...`);
    // don't assume controller; try env list and pick first that works during heartbeat
    activeController = envControllers[0];
  // pull server config (if available) before starting heartbeats
  try { await fetchServerConfig(activeController, token); } catch (e) { /* ignore */ }
  return heartbeatLoop(clientId, token);
  }

  const fingerprint = await getOrCreateFingerprint();
  const hostname = os.hostname();
  const ip = firstIPv4() || '0.0.0.0';

  console.log('[agent] enrolling…');
  const { requestId, controllerUsed } = await tryEnrollWithBackoff({ hostname, ip, fingerprint, controllers: envControllers });
  activeController = controllerUsed;
  console.log(`[agent] requestId=${requestId}. Waiting for approval...`);
  const { clientId, bootstrapToken } = await pollApproval(requestId, activeController);
  console.log(`[agent] approved as ${clientId}. Starting heartbeats.`);
  await fs.writeJson(CLIENT_FILE, { clientId, token: bootstrapToken }, { spaces: 2 });
  
  // DEV ONLY: open viewer page locally
  try {
    const base = process.env.VIEWER_BASE || 'http://localhost:8080';
    await openUrl(`${base}/viewer?id=${clientId}`);
  } catch (e) {
    console.warn('[agent] could not open viewer:', e.message);
  }

  // fetch server config (may update HEARTBEAT_MS) then begin heartbeats
  try { await fetchServerConfig(activeController, bootstrapToken); } catch (e) { /* ignore */ }
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

async function postEnrollRequest(controller, { hostname, ip, fingerprint }) {
  const { data } = await axios.post(`${controller}/enroll/requests`, { hostname, ip, fingerprint }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
  });
  return data; // { requestId, status }
}

async function pollApproval(requestId, controller) {
  // Poll every 2s until approved or rejected
  while (true) {
  const { data } = await axios.get(`${controller}/enroll/status/${requestId}`, { timeout: 10000 });
    if (data.status === 'approved') return data; // { status, clientId, bootstrapToken }
    if (data.status === 'rejected') throw new Error('Enrollment rejected by server');
    await sleep(2000);
  }
}

async function heartbeatLoop(clientId, token) {
  while (true) {
    try {
  const controller = activeController || getControllersFromEnv()[0];
  await axios.post(`${controller}/clients/${clientId}/heartbeat`, {
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
    // before sleeping, periodically refresh server config
    try {
      const controller = activeController || getControllersFromEnv()[0];
      await fetchServerConfig(controller, token);
    } catch (e) {
      // ignore config fetch errors
    }
    await sleep(HEARTBEAT_MS);
  }
}

// fetch /config from the server and apply any server-side settings
async function fetchServerConfig(controller, token) {
  if (!controller) return;
  try {
    const { data } = await axios.get(`${controller}/config`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000
    });
    if (data && typeof data.heartbeatMs === 'number') {
      HEARTBEAT_MS = Number(data.heartbeatMs);
      console.log(`[agent] updated HEARTBEAT_MS=${HEARTBEAT_MS} from server config`);
    }
  } catch (e) {
    // don't propagate
  }
}

async function relaunch() {
  const fingerprint = await getOrCreateFingerprint();
  const hostname = os.hostname();
  const ip = firstIPv4() || '0.0.0.0';
  console.log('[agent] re-enrolling…');
  const envControllers = getControllersFromEnv();
  const { requestId, controllerUsed } = await tryEnrollWithBackoff({ hostname, ip, fingerprint, controllers: envControllers });
  activeController = controllerUsed;
  console.log(`[agent] requestId=${requestId}. Waiting for approval...`);
  const { clientId, bootstrapToken } = await pollApproval(requestId, activeController);
  await fs.writeJson(CLIENT_FILE, { clientId, token: bootstrapToken }, { spaces: 2 });
  return heartbeatLoop(clientId, bootstrapToken);
}

// Enrollment with retry/backoff across multiple controllers
async function tryEnrollWithBackoff({ hostname, ip, fingerprint, controllers = [] }) {
  const maxAttemptsPerController = 5;
  const baseDelayMs = 1000;
  const ctrlList = controllers.length ? controllers : getControllersFromEnv();

  // try controllers in round-robin, but keep retrying forever
  while (true) {
    for (const ctrl of ctrlList) {
      const controller = normalizeUrl(ctrl) || ctrl;
      for (let attempt = 1; attempt <= maxAttemptsPerController; attempt++) {
        try {
          console.log(`[agent] trying enroll -> ${controller} (attempt ${attempt})`);
          const data = await postEnrollRequest(controller, { hostname, ip, fingerprint });
          // success
          return { ...data, controllerUsed: controller };
        } catch (e) {
          const wait = baseDelayMs * Math.pow(2, attempt - 1);
          console.warn(`[agent] enroll failed to ${controller} (attempt ${attempt}): ${e?.message || e}. retrying in ${wait}ms`);
          await sleep(wait);
        }
      }
      // after attempts for this controller, move to next controller
    }
    // after trying all controllers, wait before next round
    const roundWait = 10000;
    console.log(`[agent] completed a round of controller attempts, sleeping ${roundWait}ms before retrying controllers`);
    await sleep(roundWait);
  }
}


function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
