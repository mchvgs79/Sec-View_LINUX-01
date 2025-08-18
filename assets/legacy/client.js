const axios = require('axios');
const WebSocket = require('ws');
const os = require('os');
const { execSync } = require('child_process');

// Attempt to get serial number
function getSerialNumber() {
  try {
    const output = execSync("cat /proc/cpuinfo | grep Serial | awk '{print $3}'").toString().trim();
    return output || 'unknown';
  } catch (err) {
    console.error('Failed to get serial number:', err.message);
    return 'unknown';
  }
}

// Get screen resolution if available
function getScreenResolution() {
  try {
    const output = execSync("xrandr | grep '\*' | awk '{print $1}'").toString().trim();
    return output;
  } catch (err) {
    return 'unknown';
  }
}

// Get network info
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (let iface in interfaces) {
    for (let i of interfaces[iface]) {
      if (i.family === 'IPv4' && !i.internal) {
        return i.address;
      }
    }
  }
  return 'unknown';
}

const DEVICE_ID = getSerialNumber();
const SERVER_HOST = 'http://192.168.25.115:8080';
const WS_URL = 'ws://192.168.25.115:8080';

async function register() {
  try {
    const response = await axios.post(`${SERVER_HOST}/register`, {
      deviceId: DEVICE_ID,
      ip: getLocalIP(),
      hostname: os.hostname(),
      capabilities: {
        resolution: getScreenResolution(),
        arch: os.arch(),
        platform: os.platform()
      }
    });
    console.log('Registered:', response.data);
  } catch (err) {
    console.error('Registration failed:', err.message);
    throw err;
  }
}

function connectWebSocket() {
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('WebSocket connected');
    ws.send(JSON.stringify({ type: 'register', deviceId: DEVICE_ID }));
  });

  ws.on('message', (message) => {
    const msg = JSON.parse(message);
    if (msg.type === 'layout') {
      console.log('New layout received:', msg.layout);
      // Save to local file to be loaded by client-template.html
      const fs = require('fs');
      fs.writeFileSync('/tmp/current-layout.json', JSON.stringify(msg.layout));
    }
  });

  ws.on('close', () => {
    console.log('WebSocket disconnected, retrying in 5s...');
    setTimeout(connectWebSocket, 5000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

async function main() {
  console.log('Starting Display Client...');

  const maxAttempts = 10;
  let attempts = 0;
  let registered = false;

  while (attempts < maxAttempts && !registered) {
    try {
      if (DEVICE_ID === 'unknown') throw new Error('Invalid serial number');
      await register();
      registered = true;
    } catch (err) {
      attempts++;
      if (attempts < maxAttempts) {
        console.log('Retrying registration in 5 seconds...');
        await new Promise(res => setTimeout(res, 5000));
      }
    }
  }

  if (!registered) {
    console.error('Failed to register after multiple attempts.');
    process.exit(1);
  }

  connectWebSocket();
}

main().catch(err => {
  console.error('Fatal error in client startup:', err.message);
  process.exit(1);
});