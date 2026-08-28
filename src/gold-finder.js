const mineflayer = require('mineflayer');
const { Authflow } = require('prismarine-auth');
const fs = require('fs');
const path = require('path');
const GridAnalyzer = require('./analyzer');

class GoldZoneFinder {
  constructor(config) {
    this.config = config;
    this.bot = null;
    this.running = false;
    this.analyzer = null;
    this.attempts = 0;
    this.antiKickTimers = [];
    this.tpaMode = config.tpahere?.mode || 'tpahere'; // 'tpahere' or 'tpa'
    this.onProgress = null;
    this.onFound = null;
    this.onError = null;
    this.onChat = null;
    this.onConnect = null;
    this.onTPASent = null; // callback when TPA command is sent
  }

  loadAnalysis() {
    const rp = path.resolve(__dirname, '..', 'data', 'analysis-results.json');
    if (!fs.existsSync(rp)) throw new Error('No analysis results! Run collect + analyze first.');
    const results = JSON.parse(fs.readFileSync(rp, 'utf-8'));

    this.analyzer = new GridAnalyzer(this.config);
    this.analyzer.gridSize = Math.ceil((this.config.worldBorder * 2) / this.analyzer.cellSize);
    this.analyzer.grid = Array.from({ length: this.analyzer.gridSize }, () =>
      Array.from({ length: this.analyzer.gridSize }, () => 0)
    );
    this.analyzer.threshold = results.threshold;

    const coordsPath = path.resolve(__dirname, '..', 'data', 'rtp-coords.json');
    if (fs.existsSync(coordsPath)) {
      const coords = JSON.parse(fs.readFileSync(coordsPath, 'utf-8'));
      for (const c of coords) {
        const col = Math.floor((c.x + this.config.worldBorder) / this.analyzer.cellSize);
        const row = Math.floor((c.z + this.config.worldBorder) / this.analyzer.cellSize);
        if (row >= 0 && row < this.analyzer.gridSize && col >= 0 && col < this.analyzer.gridSize)
          this.analyzer.grid[row][col]++;
      }
    }
    return results;
  }

  async createBot() {
    const { host, port, version } = this.config.server;
    const { email, password } = this.config.auth;
    const cacheDir = path.resolve(__dirname, '..', 'data', 'auth-cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const authflow = new Authflow(email, cacheDir, { password, flow: 'msal' });
    const result = await authflow.getMinecraftJavaToken();
    this.onConnect?.(result.profile.name);
    this.bot = mineflayer.createBot({
      host, port: port || 25565,
      username: result.profile.name,
      authServer: 'microsoft',
      accessToken: result.accessToken,
      version: version || '1.21.4',
      hideErrors: false, keepAlive: true
    });
    return this.bot;
  }

  setupListeners() {
    const bot = this.bot;
    bot.on('spawn', () => setTimeout(() => this.startSearch(), 3000));

    // Listen for chat messages - detect clickable confirm buttons
    bot.on('message', (jsonMsg) => {
      const msg = jsonMsg.toString().trim();
      if (msg.length > 0) this.onChat?.(msg);

      // Try to auto-click confirm buttons in chat
      // Some servers use chat components with clickEvent for TPA confirms
      if (jsonMsg.extra && Array.isArray(jsonMsg.extra)) {
        for (const part of jsonMsg.extra) {
          // Look for accept/confirm click actions
          if (part.clickEvent && (
            part.text?.toLowerCase().includes('accept') ||
            part.text?.toLowerCase().includes('confirm') ||
            part.text?.toLowerCase().includes('green')
          )) {
            if (part.clickEvent.action === 'run_command' || part.clickEvent.action === 'suggest_command') {
              const cmd = part.clickEvent.value;
              console.log(`[GoldFinder] Auto-clicking confirm: ${cmd}`);
              bot.chat(cmd);
            }
          }
        }
      }

      // Also handle raw clickEvent at top level
      if (jsonMsg.clickEvent) {
        const action = jsonMsg.clickEvent.action;
        const value = jsonMsg.clickEvent.value;
        if ((action === 'run_command' || action === 'suggest_command') && value) {
          const text = jsonMsg.toString().toLowerCase();
          if (text.includes('accept') || text.includes('confirm')) {
            console.log(`[GoldFinder] Auto-clicking top-level confirm: ${value}`);
            bot.chat(value);
          }
        }
      }
    });

    // Handle window-based confirm GUIs (chest/inventory menus)
    bot.on('windowOpen', (window) => {
      const title = (window.title || '').toString().toLowerCase();
      if (title.includes('tpa') || title.includes('teleport') || title.includes('confirm') || title.includes('request')) {
        console.log(`[GoldFinder] TPA confirm GUI detected: ${window.title}`);
        // Try to find and click the green pane / accept button
        // Green stained glass pane = slot 11 or 13 in a 3-row GUI typically
        const slots = [10, 11, 12, 13, 14, 15, 16]; // Common accept button positions
        for (const slot of slots) {
          const item = window.slots[slot];
          if (item && item.name) {
            const name = item.name.toLowerCase();
            if (name.includes('accept') || name.includes('confirm') || name.includes('green') ||
                name.includes('stained glass') || name.includes('green pane')) {
              console.log(`[GoldFinder] Clicking accept slot ${slot}: ${item.name}`);
              bot.clickWindow(slot, 0, 0);
              bot.closeWindow(window);
              break;
            }
          }
        }
      }
    });

    bot.on('kicked', (reason) => { this.onError?.(new Error(`Kicked: ${reason}`)); this.stop(); });
    bot.on('error', (err) => this.onError?.(err));
    bot.on('end', () => {
      this.cleanupAntiKick();
      if (this.running) setTimeout(() => this.reconnect(), 10000);
    });
  }

  async reconnect() {
    if (!this.running) return;
    try { await this.createBot(); this.setupListeners(); }
    catch (err) { this.onError?.(err); setTimeout(() => this.reconnect(), 30000); }
  }

  async startSearch() {
    this.running = true;
    const command = this.config.rtp.command;
    const delay = this.config.rtp.delayMs;
    const target = this.config.tpahere.target;
    this.startAntiKick();

    while (this.running) {
      this.attempts++;
      try {
        const coord = await this.doSingleRTP(command);
        if (coord) {
          const isGold = this.analyzer.isGoldZone(coord.x, coord.z);
          this.onProgress?.(this.attempts, coord.x, coord.z, isGold);
          if (isGold) {
            this.onFound?.(coord.x, coord.z, this.attempts);
            if (this.config.tpahere.enabled && target) {
              this.sendTPA(target);
            }
            // Stay alive 3 min for TPA to be accepted
            await this.sleep(180000);
            this.stop();
            return;
          }
        }
      } catch (err) { this.onError?.(err); await this.sleep(delay * 3); continue; }
      await this.sleep(delay);
    }
    this.stop();
  }

  /**
   * Send TPA based on current mode
   * mode 'tpahere' = /tpahere <target> (summon player to bot)
   * mode 'tpa' = /tpa <target> (bot goes to player)
   */
  sendTPA(target) {
    const bot = this.bot;
    if (!bot) return;

    if (this.tpaMode === 'tpahere') {
      // Summon the player to the bot's gold zone location
      console.log(`[GoldFinder] Sending /tpahere ${target}`);
      bot.chat(`/tpahere ${target}`);
      this.onTPASent?.(`/tpahere ${target}`);
    } else {
      // Bot teleports to the player (player stays where they are)
      console.log(`[GoldFinder] Sending /tpa ${target}`);
      bot.chat(`/tpa ${target}`);
      this.onTPASent?.(`/tpa ${target}`);
    }
  }

  doSingleRTP(command) {
    return new Promise((resolve, reject) => {
      const bot = this.bot;
      if (!bot || !bot.entity) { reject(new Error('Not spawned')); return; }
      const startPos = { x: bot.entity.position.x, z: bot.entity.position.z };
      let resolved = false, chatCoords = null;
      const chatHandler = (jsonMsg) => {
        const msg = jsonMsg.toString();
        const m = msg.match(/(-?\d{1,6})[,.\s]+(-?\d{1,3})[,.\s]+(-?\d{1,6})/);
        if (m && this.config.rtp.parseFromChat)
          chatCoords = { x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]) };
      };
      const posHandler = () => {
        if (resolved) return;
        const pos = bot.entity.position;
        const dist = Math.sqrt(Math.pow(pos.x - startPos.x, 2) + Math.pow(pos.z - startPos.z, 2));
        if (dist > 100) { resolved = true; cleanup(); resolve(chatCoords || { x: pos.x, y: pos.y, z: pos.z }); }
      };
      const timeoutId = setTimeout(() => {
        if (!resolved) { resolved = true; cleanup();
          const pos = bot.entity?.position;
          pos ? resolve({ x: pos.x, y: pos.y, z: pos.z }) : reject(new Error('Timeout'));
        }
      }, 15000);
      const cleanup = () => { clearTimeout(timeoutId); bot.removeListener('message', chatHandler); bot.removeListener('position', posHandler); };
      bot.on('message', chatHandler); bot.on('position', posHandler); bot.chat(command);
    });
  }

  startAntiKick() {
    const bot = this.bot;
    const mt = setInterval(() => { if (bot?.entity && this.running) bot.entity.pitch = (Math.random() - 0.5) * 0.5; }, 30000);
    const ct = setInterval(() => { if (bot && this.running) bot.chat('.'); }, 120000);
    this.antiKickTimers = [mt, ct];
  }

  cleanupAntiKick() { this.antiKickTimers.forEach(t => clearInterval(t)); this.antiKickTimers = []; }
  stop() { this.running = false; this.cleanupAntiKick(); if (this.bot) { this.bot.quit(); this.bot = null; } }
  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = GoldZoneFinder;