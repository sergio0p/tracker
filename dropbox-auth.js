/**
 * Dropbox PKCE OAuth2 Authentication for GitHub Pages
 *
 * Handles the entire auth flow in the browser with no backend:
 * 1. First visit: redirect to Dropbox for authorization
 * 2. Callback: exchange code for tokens (access + refresh)
 * 3. Subsequent visits: auto-refresh tokens silently
 *
 * Setup: Create a Dropbox app at https://www.dropbox.com/developers/apps
 * - Choose "Scoped access" + "Full Dropbox"
 * - Add your GitHub Pages URL as redirect URI
 * - Enable permissions: files.metadata.read, files.content.read, files.content.write
 * - Copy the App Key below
 */

// ============================================================
// CONFIGURATION — Update these for your Dropbox app
// ============================================================
const DROPBOX_CLIENT_ID = 'kt1vtwzua07s4mc';

// Redirect URI must match exactly what's registered in Dropbox App Console.
const REDIRECT_URI = 'https://sergio0p.github.io/tracker/';

// ============================================================
// localStorage keys
// ============================================================
const TOKEN_KEY = 'dbx_access_token';
const REFRESH_KEY = 'dbx_refresh_token';
const EXPIRY_KEY = 'dbx_token_expiry';
const VERIFIER_KEY = 'dbx_code_verifier';

// ============================================================
// DropboxAuth class
// ============================================================
class DropboxAuth {
  constructor() {
    this.dbxAuth = new Dropbox.DropboxAuth({ clientId: DROPBOX_CLIENT_ID });
    this.dbx = null;
  }

  /** Check if we have a non-expired access token */
  isAuthenticated() {
    const token = localStorage.getItem(TOKEN_KEY);
    const expiry = localStorage.getItem(EXPIRY_KEY);
    if (!token) return false;
    // Expired if within 5-minute buffer
    if (expiry && Date.now() > (parseInt(expiry) - 300000)) {
      return false;
    }
    return true;
  }

  /** Check if we can silently renew */
  hasRefreshToken() {
    return !!localStorage.getItem(REFRESH_KEY);
  }

  /**
   * Initialize: restore session or handle OAuth callback.
   * Returns true if authenticated, false if user needs to click "Connect".
   */
  async init() {
    // Step 1: Check for OAuth callback (code in URL params)
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');

    if (code) {
      await this._handleCallback(code);
      // Clean URL (remove ?code=...)
      window.history.replaceState({}, '', window.location.pathname);
      return true;
    }

    // Step 2: Try existing valid token
    if (this.isAuthenticated()) {
      this._setClient(localStorage.getItem(TOKEN_KEY));
      return true;
    }

    // Step 3: Try silent refresh
    if (this.hasRefreshToken()) {
      try {
        await this._refreshToken();
        return true;
      } catch (e) {
        console.error('Token refresh failed:', e);
        this._clearTokens();
        return false;
      }
    }

    return false;
  }

  /** Start OAuth flow — redirects to Dropbox */
  async startAuth() {
    const authUrl = await this.dbxAuth.getAuthenticationUrl(
      REDIRECT_URI,
      undefined,    // state
      'code',       // response type
      'offline',    // token_access_type: gives refresh token
      undefined,    // scope
      undefined,    // includeGrantedScopes
      true          // usePKCE
    );

    // Save code verifier for callback (sessionStorage survives redirect)
    const codeVerifier = this.dbxAuth.getCodeVerifier();
    sessionStorage.setItem(VERIFIER_KEY, codeVerifier);

    window.location.href = authUrl;
  }

  /** Handle OAuth callback — exchange code for tokens */
  async _handleCallback(code) {
    const codeVerifier = sessionStorage.getItem(VERIFIER_KEY);
    if (!codeVerifier) {
      throw new Error('No code verifier found. Please try connecting again.');
    }

    this.dbxAuth.setCodeVerifier(codeVerifier);
    const response = await this.dbxAuth.getAccessTokenFromCode(REDIRECT_URI, code);
    const result = response.result;

    // Store tokens
    localStorage.setItem(TOKEN_KEY, result.access_token);
    if (result.refresh_token) {
      localStorage.setItem(REFRESH_KEY, result.refresh_token);
    }
    const expiresIn = result.expires_in || 14400; // default 4 hours
    localStorage.setItem(EXPIRY_KEY, String(Date.now() + expiresIn * 1000));

    sessionStorage.removeItem(VERIFIER_KEY);
    this._setClient(result.access_token);
  }

  /** Silently refresh access token using stored refresh token */
  async _refreshToken() {
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    this.dbxAuth.setRefreshToken(refreshToken);
    this.dbxAuth.setClientId(DROPBOX_CLIENT_ID);

    await this.dbxAuth.refreshAccessToken();
    const newToken = this.dbxAuth.getAccessToken();

    localStorage.setItem(TOKEN_KEY, newToken);
    localStorage.setItem(EXPIRY_KEY, String(Date.now() + 14400 * 1000));

    this._setClient(newToken);
  }

  /** Create the Dropbox API client with a valid token */
  _setClient(accessToken) {
    this.dbx = new Dropbox.Dropbox({ accessToken });
  }

  /** Clear all stored tokens */
  _clearTokens() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(EXPIRY_KEY);
  }

  /** Get the authenticated Dropbox client */
  getClient() {
    return this.dbx;
  }

  /** Ensure token is fresh before an API call */
  async ensureFreshToken() {
    if (!this.isAuthenticated() && this.hasRefreshToken()) {
      await this._refreshToken();
    }
  }
}
