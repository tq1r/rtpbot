/**
 * RTP Data Collector - Mineflayer bot that collects RTP coordinates
 * Improved: cooldown detection, randomized delays, better coord parsing,
 *          anti-kick that looks human, auto-reconnect with data preservation
 */

const mineflayer = require('mineflayer');
const { Authflow } = require('prismarine-auth');
const fs = require('fs');
const path = require('path');

const ANTI_KICK_MESSAGES = [
  '.', '..', '...', '....',
  'lol', 'hmm', 'ok', 'gg',
];

const RTP_COORD_PATTERNS = [
  // "Teleported to 12345, 64, -67890"
  /(?:teleported|warped|sent)\s+(?:to\s+)?\(?\s*(-?\d{1,6})\s*[,\s]+(-?\d{1,3})\s*[,\s]+(-?\d{1,6})/i,
  // "X: 12345, Y: 64, Z: -67890"
  /[Xx]\s*[:=]\s*(-?\d{1,6})[,\s]+[Yy]\s*[:=]\s*(-?\d{1,3})[,\s]+[Zz]\s*[:=]\s*(-?\d{1,6})/,
  // "12345, 64, -67890" (bare coordinates)
  /\b(-?\d{4,6})\s*[,\s]+(-?\d{1,3})\s*[,\s]+(-?\d{4,6})\b/,
];

const COOLDOWN_PATTERN = /(?:wait|cooldown|please wait)\s+(?:for\s+)?(?:another\s+)?(\d+)\s*(second|sec|minute|min)/i;

class RTPCollector {
  constructor(config) {
    this.config = config;
    this.coords = [];
    this.running = false;
    this.bot = null;
    this.startTime = null;
    this.antiKickTimers = [];
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 10;
    this.onProgress = null;
    this.onComplete = null;
    this.onError = null;
    this.onChat = null;
    this.onConnect = null;
    this.onWarning = null; // callback(warning message)
  }

  async createBot() {
    const { host, port, version } = this.config.server;
    const { email, password } = this.config.auth;

    const cacheDir = path.resolve(__dirname, '..', 'data', 'auth-cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    const authflow = new Authflow(email, cacheDir, { password });
    const result = await authflow.getMinecraftJavaToken();

    this.onConnect?.(result.profile.name);

    this.bot = mineflayer.createBot({
      host,
      port: port || 25565,
      username: result.profile.name,
      authServer: 'microsoft',
      accessToken: result.accessToken,
      version: version || '1.21.4',
      hideErrors: false,
      keepAlive: true
    });

    return this.bot;
  }

  setupListeners() {
    const bot = this.bot;

    bot.on('spawn', () => {
      console.log('[Collector] Spawned, waiting 5s before starting...');
      setTimeout(() => this.startCollection(), 5000);
    });

    bot.on('message', (jsonMsg) => {
      const msg = jsonMsg.toString().trim();
      if (msg.length > 0) this.onChat?.(msg);
    });

    bot.on('kicked', (reason) => {
      console.error(`[Collector] Kicked: ${reason}`);
      this.onError?.(new Error(`Kicked: ${reason}`));
      this.stop();
    });

    bot.on('error', (err) => {
      // Suppress common non-fatal errors
      if (err.message.includes('timed out') || err.message.includes('ECONNRESET')) {
        console.log(`[Collector] Connection error (will reconnect): ${err.message}`);
      } else {
        this.onError?.(err);
      }
    });

    bot.on('end', (reason) => {
      this.cleanupAntiKick();
      if (this.running) {
        console.log(`[Collector] Disconnected: ${reason}. Reconnecting in 10s...`);
        setTimeout(() => this.reconnect(), 10000);
      }
    });
  }

  async reconnect() {
    if (!this.running) return;
    const attempt = 1;
    const maxAttempts = 5;
    const backoff = () => Math.min(10000 * Math.pow(2, attempt), 300000);

    const tryReconnect = async () => {
      if (!this.running || attempt > maxAttempts) {
        if (attempt > maxAttempts) {
          this.onError?.(new Error(`Failed to reconnect after ${maxAttempts} attempts. Stopped.`));
          this.stop();
        }
        return;
      }
      console.log(`[Collector] Reconnect attempt ${attempt}/${maxAttempts}...`);
      try {
        await this.createBot();
        this.setupListeners();
        console.log('[Collector] Reconnected!');
      } catch (err) {
        console.error(`[Collector] Reconnect failed:`, err.message);
        setTimeout(tryReconnect, backoff());
      }
    };
    setTimeout(tryReconnect, 10000);
  }

  async startCollection(overrideCount) {
    this.running = true;
    this.startTime = Date.now();
    const target = overrideCount || this.config.rtp.sampleCount;
    const command = this.config.rtp.command;
    const baseDelay = this.config.rtp.delayMs;

    this.loadExistingData();
    this.startAntiKick();

    // Skip to where we left off
    const startIndex = this.coords.length;
    if (startIndex > 0) {
      console.log(`[Collector] Resuming from ${startIndex} collected coords (target: ${target})`);
    }

    for (let i = startIndex; i < target; i++) {
      if (!this.running) break;

      try {
        const result = await this.doSingleRTP(command);

        if (result.coord) {
          // Validate coordinates are within world border
          const wb = this.config.worldBorder;
          if (Math.abs(result.coord.x) <= wb && Math.abs(result.coord.z) <= wb) {
            this.coords.push(result.coord);
            this.saveData();
            this.consecutiveErrors = 0;

            const elapsed = Date.now() - this.startTime;
            const count = this.coords.length;
            const rate = (count / (elapsed / 60000)).toFixed(1);
            this.onProgress?.(count, target, elapsed, parseFloat(rate));
          } else {
            console.log(`[Collector] Coordinate outside world border, skipping: X=${result.coord.x}, Z=${result.coord.z}`);
          }
        }

        // Handle cooldown if server reported one
        if (result.cooldownMs > 0) {
          console.log(`[Collector] Server cooldown detected, waiting ${result.cooldownMs}ms`);
          this.onWarning?.(`Cooldown detected. Waiting ${(result.cooldownMs / 1000).toFixed(0)}s...`);
          await this.sleep(result.cooldownMs);
        } else {
          // Randomized delay to look human (base delay +/- 30%)
          const jitter = baseDelay * 0.3;
          const delay = baseDelay + (Math.random() * jitter * 2 - jitter);
          await this.sleep(delay);
        }
      } catch (err) {
        this.consecutiveErrors++;
        this.onError?.(err);

        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
          this.onError?.(new Error(`${this.maxConsecutiveErrors} consecutive errors. Stopping to prevent issues.`));
          this.stop();
          return;
        }

        // Exponential backoff on errors
        const backoffMs = Math.min(baseDelay * Math.pow(2, this.consecutiveErrors), 60000);
        console.log(`[Collector] Error ${this.consecutiveErrors}/${this.maxConsecutiveErrors}, waiting ${backoffMs}ms...`);
        await this.sleep(backoffMs);
      }
    }

    const duration = Date.now() - this.startTime;
    this.onComplete?.(this.coords, duration);
    this.stop();
  }

  doSingleRTP(command) {
    return new Promise((resolve, reject) => {
      const bot = this.bot;
      if (!bot || !bot.entity) { reject(new Error('Bot not spawned')); return; }

      const startPos = { x: bot.entity.position.x, z: bot.entity.position.z };
      let resolved = false;
      let chatCoords = null;
      let cooldownMs = 0;

      const chatHandler = (jsonMsg) => {
        const msg = jsonMsg.toString();

        // Try to parse coordinates from chat
        if (this.config.rtp.parseFromChat) {
          for (const pattern of RTP_COORD_PATTERNS) {
            const m = msg.match(pattern);
            if (m) {
              chatCoords = {
                x: parseFloat(m[1]),
                y: parseFloat(m[2]),
                z: parseFloat(m[3])
              };
              break;
            }
          }
        }

        // Detect cooldown messages
        const cdMatch = msg.match(COOLDOWN_PATTERN);
        if (cdMatch) {
          let cdSec = parseInt(cdMatch[1]);
          const unit = (cdMatch[2] || 's').toLowerCase();
          if (unit.startsWith('min')) cdSec *= 60;
          cooldownMs = (cdSec + 1) * 1000; // +1s buffer
        }

        // Detect "already teleporting" or "on cooldown" without specific time
        if (msg.toLowerCase().includes('on cooldown') || msg.toLowerCase().includes('already teleporting')) {
          cooldownMs = Math.max(cooldownMs, 5000);
        }
      };

      const posHandler = () => {
        if (resolved) return;
        const pos = bot.entity.position;
        const dist = Math.sqrt(Math.pow(pos.x - startPos.x, 2) + Math.pow(pos.z - startPos.z, 2));
        if (dist > 100) {
          resolved = true;
          cleanup();
          resolve({
            coord: chatCoords || { x: pos.x, y: pos.y, z: pos.z },
            cooldownMs
          });
        }
      };

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          const pos = bot.entity?.position;
          if (pos) {
            // Even on timeout, if we moved, record it
            const dist = Math.sqrt(Math.pow(pos.x - startPos.x, 2) + Math.pow(pos.z - startPos.z, 2));
            resolve({
              coord: dist > 50 ? (chatCoords || { x: pos.x, y: pos.y, z: pos.z }) : null,
              cooldownMs
            });
          } else {
            reject(new Error('Timeout - no position'));
          }
        }
      }, 15000);

      const cleanup = () => {
        clearTimeout(timeoutId);
        bot.removeListener('message', chatHandler);
        bot.removeListener('position', posHandler);
      };

      bot.on('message', chatHandler);
      bot.on('position', posHandler);
      bot.chat(command);
    });
  }

  startAntiKick() {
    if (!this.bot) return;
    const bot = this.bot;
    let msgIdx = 0;

    // Slight head movement every 25-35s (random interval)
    const moveTimer = setInterval(() => {
      if (!bot || !bot.entity || !this.running) return;
      bot.entity.pitch = (Math.random() - 0.5) * 0.3;
      bot.entity.yaw += (Math.random() - 0.5) * 0.4;
    }, 25000 + Math.random() * 10000);

    // Occasional chat message every 90-150s
    const chatTimer = setInterval(() => {
      if (!bot || !this.running) return;
      bot.chat(ANTI_KICK_MESSAGES[msgIdx % ANTI_KICK_MESSAGES.length]);
      msgIdx++;
    }, 90000 + Math.random() * 60000);

    this.antiKickTimers = [moveTimer, chatTimer];
  }

  cleanupAntiKick() {
    this.antiKickTimers.forEach(t => clearInterval(t));
    this.antiKickTimers = [];
  }

  loadExistingData() {
    const p = path.resolve(__dirname, '..', 'data', 'rtp-coords.json');
    if (fs.existsSync(p)) {
      try {
        const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (Array.isArray(d)) {
          this.coords = d;
          // Validate all existing coords
          this.coords = this.coords.filter(c =>
            c && typeof c.x === 'number' && typeof c.z === 'number' &&
            Math.abs(c.x) <= this.config.worldBorder &&
            Math.abs(c.z) <= this.config.worldBorder
          );
        }
      } catch (e) {
        console.log('[Collector] Existing data corrupted, starting fresh');
      }
    }
  }

  saveData() {
    const p = path.resolve(__dirname, '..', 'data', 'rtp-coords.json');
    fs.writeFileSync(p, JSON.stringify(this.coords, null, 2));
  }

  stop() {
    this.running = false;
    this.cleanupAntiKick();
    if (this.bot) { this.bot.quit(); this.bot = null; }
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = RTPCollector;
