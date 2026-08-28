/**
 * Patches @xboxreplay/xboxlive-auth to fix PPFT parsing
 * Microsoft changed their login page HTML breaking the old regex.
 * This must be required BEFORE prismarine-auth loads xboxlive-auth.
 */

const axios = require('axios');
const qs = require('querystring');

const AUTH_URL = 'https://login.live.com/oauth20_authorize.srf';
const AUTH_PARAMS = {
  client_id: '000000004C12AE6F',
  redirect_uri: 'https://login.live.com/oauth20_desktop.srf',
  scope: 'service::user.auth.xboxlive.com::MBI_SSL',
  display: 'touch',
  response_type: 'token',
  locale: 'en'
};

const mod = require('@xboxreplay/xboxlive-auth');

// Replace preAuth with fixed version that handles current Microsoft login page format
mod.preAuth = () =>
  axios.get(`${AUTH_URL}?${qs.stringify(AUTH_PARAMS)}`).then(response => {
    if (response.status !== 200) {
      throw new Error('Pre-authentication failed.');
    }
    const body = response.data || '';
    const cookie = (response.headers['set-cookie'] || [])
      .map(c => c.split(';')[0])
      .join('; ');

    let PPFT = null;
    let urlPost = null;

    // Extract sFTTag from ServerData JSON (new format: embedded in JS object)
    const sftMatch = body.match(/sFTTag"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
    if (sftMatch) {
      const sftTag = sftMatch[1].replace(/\\"/g, '"').replace(/\\\//g, '/');
      const valMatch = sftTag.match(/value="([^"]+)"/);
      if (valMatch) PPFT = valMatch[1];
    }

    // Fallback: try the old regex format too
    if (!PPFT) {
      const oldMatch = body.match(/sFTTag:'.*?value="(.*?)"\/'/);
      if (oldMatch) PPFT = oldMatch[1];
    }

    // Extract urlPost from ServerData JSON
    const urlMatch = body.match(/urlPost"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (urlMatch) {
      urlPost = urlMatch[1].replace(/\\\//g, '/');
    }

    // Fallback: try old urlPost format
    if (!urlPost) {
      const oldUrlMatch = body.match(/urlPost:'(.+?(?='))/);
      if (oldUrlMatch) urlPost = oldUrlMatch[1];
    }

    if (!PPFT) throw new Error('Could not match "PPFT" parameter. Microsoft may have changed their login page again.');
    if (!urlPost) throw new Error('Could not match "urlPost" parameter.');

    return {
      cookie,
      matches: { PPFT, urlPost }
    };
  }).catch(err => {
    if (err.__XboxReplay__) throw err;
    throw new Error(err.message);
  });

console.log('[patch-auth] Xbox Live auth PPFT patch applied');
